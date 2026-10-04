import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import { resolve, relative, basename, dirname, isAbsolute, sep } from "node:path";
import type { AstIndexClient } from "../ast-index/client.js";
import type { ExploreAreaArgs } from "../core/validation.js";
import { resolveSafePath } from "../core/validation.js";
import { outlineDir, CODE_EXTENSIONS } from "./outline.js";
import {
  isTestFile,
  isTestPath,
  resolveImportPath,
  testSubject,
} from "./related-files.js";

const execFileAsync = promisify(execFile);

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

// v0.28.3 — tightened from 20/500. Two independent verification runs
// (Sonnet 4.6 + Opus 4.7 on docker-local-env) measured explore_area at
// -31% savings — output was larger than reading scanned files raw.
// Root cause: imports + tests + git log accumulated on top of the
// directory outline. Halving both caps keeps the structural overview
// while dropping the tail nobody actually reads. Self-sizing (compare
// against baseline and trim if exceeded) deferred to v0.29.0.
// Source files whose imports are read (JS/TS: a file read each) and
// possible importers verified; both caps are reported when hit.
const MAX_IMPORT_FILES = 30;
const MAX_IMPORTER_CHECKS = 50;
const MAX_OUTPUT_LINES = 200;

export interface ExploreAreaMeta {
  dir: string;
  codeFiles: string[];
  testFiles: string[];
  internalDeps: string[];
  importedBy: string[];
  externalDeps: string[];
  changeCount: number;
}

// ──────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────

export async function handleExploreArea(
  args: ExploreAreaArgs,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  meta: ExploreAreaMeta;
}> {
  // Resolve path — if it points to a file, use its parent directory
  let absPath = resolveSafePath(projectRoot, args.path);
  const pathStat = await stat(absPath).catch(() => null);
  if (!pathStat) {
    return {
      content: [{ type: "text", text: `Path "${args.path}" not found.` }],
      meta: {
        dir: args.path,
        codeFiles: [],
        testFiles: [],
        internalDeps: [],
        importedBy: [],
        externalDeps: [],
        changeCount: 0,
      },
    };
  }
  if (!pathStat.isDirectory()) {
    absPath = dirname(absPath);
  }

  const relDir = relative(projectRoot, absPath) || ".";
  // v0.30.0 — narrowed default from all 4 sections to the two cheap ones.
  // Telemetry (docker-local-env, 2026-04-24) showed the all-4 default giving
  // negative token reduction (-7%): `imports` builds a full dep graph and
  // `tests` walks subtrees, both easily outweighing the raw-file baseline.
  // Callers who need imports/tests now opt in explicitly via `include`.
  const include = args.include ?? ["outline", "changes"];

  // Collect code files for import/test analysis
  const codeFiles = await listCodeFiles(absPath);

  // Run all sections in parallel
  const [outlineSection, importsSection, testsSection, changesSection] =
    await Promise.allSettled([
      include.includes("outline")
        ? buildOutlineSection(absPath, projectRoot, astIndex)
        : Promise.resolve(null),
      include.includes("imports")
        ? buildImportsSection(codeFiles, absPath, projectRoot, astIndex)
        : Promise.resolve(null),
      include.includes("tests")
        ? buildTestsSection(codeFiles, absPath, projectRoot, astIndex)
        : Promise.resolve(null),
      include.includes("changes")
        ? buildChangesSection(relDir, projectRoot)
        : Promise.resolve(null),
    ]);

  // Assemble output
  const lines: string[] = [];
  const subdirCount = await countSubdirs(absPath);
  lines.push(
    `AREA: ${relDir}/ (${codeFiles.length} code files${subdirCount > 0 ? `, ${subdirCount} subdirs` : ""})`,
  );
  lines.push("");

  // Outline
  const outlineLines = extractResult(outlineSection);
  if (outlineLines) {
    lines.push("STRUCTURE:");
    lines.push(...outlineLines);
    lines.push("");
  }

  // Imports
  const importLines = extractResult(importsSection)?.lines ?? null;
  if (importLines) {
    lines.push(...importLines);
  }

  // Tests
  const testLines = extractResult(testsSection)?.lines ?? null;
  if (testLines) {
    lines.push(...testLines);
  }

  // Changes
  const changeLines = extractResult(changesSection)?.lines ?? null;
  if (changeLines) {
    lines.push(...changeLines);
  }

  // Truncate if needed
  if (lines.length > MAX_OUTPUT_LINES) {
    lines.length = MAX_OUTPUT_LINES;
    lines.push(
      "... truncated. Use outline() on specific subdirectories for details.",
    );
  }

  lines.push(
    "HINT: Use smart_read(file) for details, read_symbol(path, symbol) for source code, find_usages(symbol) for references.",
  );

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    meta: {
      dir: relDir,
      codeFiles: codeFiles.map((file) => relative(projectRoot, file)).sort(),
      testFiles: extractResult(testsSection)?.testFiles ?? [],
      internalDeps: extractResult(importsSection)?.internalDeps ?? [],
      importedBy: extractResult(importsSection)?.importedBy ?? [],
      externalDeps: extractResult(importsSection)?.externalDeps ?? [],
      changeCount: extractResult(changesSection)?.count ?? 0,
    },
  };
}

// ──────────────────────────────────────────────
// Outline section — reuses outlineDir from outline.ts
// ──────────────────────────────────────────────

async function buildOutlineSection(
  absPath: string,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<string[]> {
  const sections: string[] = [];
  await outlineDir(absPath, sections, 0, 2, projectRoot, astIndex);
  return sections;
}

// ──────────────────────────────────────────────
// Imports section — aggregate external deps + who imports this area
// ──────────────────────────────────────────────

async function buildImportsSection(
  codeFiles: string[],
  absPath: string,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<{
  lines: string[];
  internalDeps: string[];
  importedBy: string[];
  externalDeps: string[];
}> {
  if (
    !astIndex.isAvailable() ||
    astIndex.isDisabled() ||
    astIndex.isOversized()
  ) {
    return { lines: [], internalDeps: [], importedBy: [], externalDeps: [] };
  }

  const relOf = relPathOf(projectRoot);
  const inArea = (abs: string) => abs === absPath || abs.startsWith(absPath + sep);
  const sources = codeFiles.filter((f) => !isTestPath(relOf(f)));
  const analyzed = sources.slice(0, MAX_IMPORT_FILES);
  const externalDeps = new Set<string>();
  const internalDeps = new Set<string>();

  // What the area's source files import (tests left out)
  const importResults = await Promise.allSettled(
    analyzed.map((f) => astIndex.fileImports(f)),
  );

  importResults.forEach((result, i) => {
    if (result.status !== "fulfilled" || !result.value) return;
    for (const imp of result.value) {
      const source = imp.source;
      if (!source) continue;
      if (source.startsWith(".") || source.startsWith("/")) {
        const resolved = resolveImportPath(analyzed[i], source, projectRoot);
        const target = resolved ?? resolve(dirname(analyzed[i]), source);
        if (!inArea(target)) {
          internalDeps.add(
            resolved ? relOf(resolved) : relOf(target).replace(/\.[^./]+$/, ""),
          );
        }
      } else {
        // External package
        const pkg = source.startsWith("@")
          ? source.split("/").slice(0, 2).join("/")
          : source.split("/")[0];
        externalDeps.add(pkg);
      }
    }
  });

  // Who imports this area: files whose import lines mention an area file's
  // name, kept only when one of their imports resolves into the area.
  const candidates = new Set<string>();
  const names = [...new Set(analyzed.map((f) => basename(f).replace(/\.[^.]+$/, "")))];
  const hitLists = await Promise.allSettled(
    names.map(async (name) => astIndex.search(name, { maxResults: 200 })),
  );
  for (const hits of hitLists) {
    if (hits.status !== "fulfilled") continue;
    for (const h of hits.value) {
      if (!/\b(import|from|require|use|include)\b/.test(h.text)) continue;
      const rel = relOf(h.file);
      if (!inArea(resolve(projectRoot, rel)) && !isTestPath(rel)) candidates.add(rel);
    }
  }

  const toCheck = [...candidates].slice(0, MAX_IMPORTER_CHECKS);
  const importedBy = new Set<string>();
  await Promise.all(
    toCheck.map(async (rel) => {
      const abs = resolve(projectRoot, rel);
      const imps = await astIndex.fileImports(abs).catch(() => []);
      const hit = imps.some((imp) => {
        const r = resolveImportPath(abs, imp.source, projectRoot);
        return r !== null && inArea(r);
      });
      if (hit) importedBy.add(rel);
    }),
  );

  const lines: string[] = [];

  if (externalDeps.size > 0) {
    const deps = Array.from(externalDeps).sort().slice(0, 20);
    lines.push(
      `IMPORTS: ${deps.join(", ")}${externalDeps.size > 20 ? ` ... (${externalDeps.size} total)` : ""}`,
    );
  }

  if (internalDeps.size > 0) {
    const deps = Array.from(internalDeps).sort().slice(0, 10);
    lines.push(
      `INTERNAL DEPS: ${deps.join(", ")}${internalDeps.size > 10 ? ` ... (${internalDeps.size} total)` : ""}`,
    );
  }

  if (analyzed.length < sources.length) {
    lines.push(
      `(imports read from ${analyzed.length} of ${sources.length} source files — narrow the path for the rest)`,
    );
  }

  if (importedBy.size > 0) {
    const importers = Array.from(importedBy).sort().slice(0, 10);
    lines.push(
      `IMPORTED BY: ${importers.join(", ")}${importedBy.size > 10 ? ` ... (${importedBy.size} total)` : ""}`,
    );
  }

  if (candidates.size > toCheck.length) {
    lines.push(
      `(${candidates.size - toCheck.length} possible importers not checked)`,
    );
  }

  if (lines.length > 0) lines.push("");
  return {
    lines,
    internalDeps: Array.from(internalDeps).sort(),
    importedBy: Array.from(importedBy).sort(),
    externalDeps: Array.from(externalDeps).sort(),
  };
}

// ──────────────────────────────────────────────
// Tests section — tests of this area's files
// ──────────────────────────────────────────────

/**
 * Tests of the area: test files co-located in it, in a mirrored test dir
 * (`tests/handlers/` for `src/handlers/`) or in a top-level test root —
 * named after an area file (`x.test.ts`), or (mirrored / co-located) one
 * that imports an area file.
 */
async function buildTestsSection(
  codeFiles: string[],
  absPath: string,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<{ lines: string[]; testFiles: string[] }> {
  const relOf = relPathOf(projectRoot);
  const inArea = (abs: string) => abs === absPath || abs.startsWith(absPath + sep);
  const areaNames = new Set(
    codeFiles
      .filter((f) => !isTestPath(relOf(f)))
      .map((f) => basename(f).replace(/\.[^.]+$/, "")),
  );
  const areaTail = basename(absPath);

  // Every project test file from the index; without one, the usual places.
  let candidates: string[] = [];
  try {
    candidates = (await astIndex.listFiles()).map(relOf).filter(isTestFile);
  } catch {
    // no index file list — scan the usual places below
  }
  if (candidates.length === 0) {
    candidates = await scanTestDirs(absPath, projectRoot, areaTail);
  }

  const testFiles: string[] = [];
  for (const rel of candidates) {
    const abs = resolve(projectRoot, rel);
    const dir = dirname(rel);
    const coLocated = inArea(abs);
    const mirrored = basename(dir) === areaTail;
    const testRoot = /^(tests?|__tests__|spec)$/.test(dir);
    if (!coLocated && !mirrored && !testRoot) continue;

    if (areaNames.has(testSubject(basename(rel)))) {
      testFiles.push(rel);
      continue;
    }
    if (coLocated || mirrored) {
      const imps = await astIndex.fileImports(abs).catch(() => []);
      const importsArea = imps.some((imp) => {
        const r = resolveImportPath(abs, imp.source, projectRoot);
        return r !== null && inArea(r);
      });
      if (importsArea) testFiles.push(rel);
    }
  }

  if (testFiles.length === 0) return { lines: [], testFiles: [] };

  const sorted = [...new Set(testFiles)].sort();
  return { lines: [`TESTS: ${sorted.join(", ")}`, ""], testFiles: sorted };
}

/** Test files (relative) in the area and the conventional test dirs. */
async function scanTestDirs(
  absPath: string,
  projectRoot: string,
  areaTail: string,
): Promise<string[]> {
  const dirs = [
    absPath,
    resolve(absPath, "__tests__"),
    resolve(absPath, "tests"),
    resolve(absPath, "test"),
    resolve(projectRoot, "tests"),
    resolve(projectRoot, "test"),
    resolve(projectRoot, "__tests__"),
    resolve(projectRoot, "tests", areaTail),
    resolve(projectRoot, "test", areaTail),
    resolve(projectRoot, "__tests__", areaTail),
  ];
  const out: string[] = [];
  for (const dir of [...new Set(dirs)]) {
    try {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const rel = relative(projectRoot, resolve(dir, entry.name)).split(sep).join("/");
        if (entry.isFile() && isTestFile(rel)) out.push(rel);
      }
    } catch {
      /* missing or unreadable */
    }
  }
  return out;
}

// ──────────────────────────────────────────────
// Changes section — recent git log for this area
// ──────────────────────────────────────────────

async function buildChangesSection(
  relDir: string,
  projectRoot: string,
): Promise<{ lines: string[]; count: number }> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "--oneline", "-5", "--", relDir],
      { cwd: projectRoot, timeout: 5000 },
    );

    if (!stdout.trim()) return { lines: [], count: 0 };

    const lines: string[] = [];
    const commits = stdout.trim().split("\n");
    lines.push("RECENT CHANGES:");
    for (const line of commits) {
      lines.push(`  ${line}`);
    }
    lines.push("");
    return { lines, count: commits.length };
  } catch {
    return { lines: [], count: 0 };
  }
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/** Project-relative, `/`-separated; ast-index paths are already relative. */
function relPathOf(projectRoot: string): (p: string) => string {
  return (p) =>
    (isAbsolute(p) ? relative(projectRoot, p) : p).split(sep).join("/");
}

function extractResult<T>(settled: PromiseSettledResult<T | null>): T | null {
  if (settled.status === "fulfilled" && settled.value) {
    return settled.value;
  }
  return null;
}

async function listCodeFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
        if (CODE_EXTENSIONS.has(ext)) {
          files.push(resolve(dirPath, entry.name));
        }
      }
    }
    return files.sort();
  } catch {
    return [];
  }
}

async function countSubdirs(dirPath: string): Promise<number> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}
