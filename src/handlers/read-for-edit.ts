import { readFile, stat, access, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { relative, join, extname, resolve, basename, dirname, sep } from "node:path";
import {
  parseMarkdownSections,
  findSection,
  extractSectionContent,
  duplicateSectionNote,
} from "./markdown-sections.js";
import {
  parseYamlSections,
  findYamlSection,
  extractYamlSectionContent,
} from "./yaml-sections.js";
import {
  parseJsonSections,
  findJsonSection,
  extractJsonSectionContent,
} from "./json-sections.js";
import {
  csvRecords,
  parseCsvSectionSpec,
} from "./csv-sections.js";
import type { AstIndexClient } from "../ast-index/client.js";
import { codeLines, mentions } from "../ast-index/references.js";
import type { SymbolResolver } from "../core/symbol-resolver.js";
import type { FileCache } from "../core/file-cache.js";
import type { ContextRegistry } from "../core/context-registry.js";
import { estimateTokens } from "../core/token-estimator.js";
import { resolveSafePath } from "../core/validation.js";
import { markEditPrepared } from "../core/edit-prep-state.js";
import { assessConfidence, formatConfidence } from "../core/confidence.js";
import { structureFor } from "./read-symbol.js";

const execFileAsync = promisify(execFile);

export interface ReadForEditArgs {
  path: string;
  symbol?: string;
  symbols?: string[];
  line?: number;
  context?: number;
  include_callers?: boolean;
  include_tests?: boolean;
  include_changes?: boolean;
  section?: string;
}

const DEFAULT_CONTEXT = 5;

export async function handleReadForEdit(
  args: ReadForEditArgs,
  projectRoot: string,
  symbolResolver: SymbolResolver,
  fileCache: FileCache,
  contextRegistry: ContextRegistry,
  astIndex: AstIndexClient,
  options?: { actionableHints?: boolean },
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const absPath = resolveSafePath(projectRoot, args.path);
  // Record intent BEFORE any downstream failure: if the agent explicitly
  // called read_for_edit on this path, they have declared they want to
  // edit it next. The PreToolUse:Edit hook reads this to decide whether
  // to allow or deny the follow-up Edit. Best-effort — never throws.
  markEditPrepared(projectRoot, absPath);
  const ctx = args.context ?? DEFAULT_CONTEXT;

  // Section mode: markdown/YAML section extraction for edit
  if (args.section) {
    const ext = extname(absPath).toLowerCase();
    const supportedExts = new Set([
      ".md",
      ".markdown",
      ".yaml",
      ".yml",
      ".json",
      ".csv",
    ]);
    if (!supportedExts.has(ext)) {
      return {
        content: [
          {
            type: "text",
            text: `"section" parameter only works with Markdown, YAML, or JSON files. Got: ${ext}. Use "symbol" for code files.`,
          },
        ],
      };
    }

    const fileContent = await readFile(absPath, "utf-8");
    const fileLines = fileContent.split("\n");

    // Cache file in fileCache for read_diff baseline
    if (!fileCache.get(absPath)) {
      const fileStat = await stat(absPath);
      const hash = createHash("sha256").update(fileContent).digest("hex");
      const language =
        ext === ".csv"
          ? "csv"
          : ext === ".json"
            ? "json"
            : ext === ".md" || ext === ".markdown"
              ? "markdown"
              : "yaml";
      fileCache.set(absPath, {
        structure: {
          path: absPath,
          language,
          meta: {
            lines: fileLines.length,
            bytes: fileContent.length,
            lastModified: fileStat.mtimeMs,
            contentHash: hash,
          },
          imports: [],
          exports: [],
          symbols: [],
        },
        content: fileContent,
        lines: fileLines,
        mtime: fileStat.mtimeMs,
        hash,
        lastAccess: Date.now(),
      });
    }

    let sectionResult: {
      heading: string;
      startLine: number;
      endLine: number;
      lineCount: number;
      rawContent: string;
      label: string;
    } | null = null;
    let note = "";

    if (ext === ".md" || ext === ".markdown") {
      const sections = parseMarkdownSections(fileContent);
      const section = findSection(sections, args.section);
      if (!section) {
        const available = sections.map((s) => s.heading).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Section "${args.section}" not found in ${args.path}.\nAvailable: ${available}`,
            },
          ],
        };
      }
      const hashes = "#".repeat(section.level);
      sectionResult = {
        ...section,
        rawContent: extractSectionContent(fileLines, section),
        label: `${hashes} ${section.heading}`,
      };
      note = duplicateSectionNote(sections, args.section, (s, h) => findSection([s as typeof section], h) !== undefined);
    } else if (ext === ".yaml" || ext === ".yml") {
      const sections = parseYamlSections(fileContent);
      const section = findYamlSection(sections, args.section);
      if (!section) {
        const available = sections.map((s) => s.heading).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Section "${args.section}" not found in ${args.path}.\nAvailable: ${available}`,
            },
          ],
        };
      }
      sectionResult = {
        ...section,
        rawContent: extractYamlSectionContent(fileLines, section),
        label: section.heading,
      };
    } else if (ext === ".json") {
      const sections = parseJsonSections(fileContent);
      const section = findJsonSection(sections, args.section);
      if (!section) {
        const available = sections.map((s) => s.heading).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Section "${args.section}" not found in ${args.path}.\nAvailable: ${available}`,
            },
          ],
        };
      }
      sectionResult = {
        ...section,
        rawContent: extractJsonSectionContent(fileLines, section),
        label: section.heading,
      };
    } else if (ext === ".csv") {
      const records = csvRecords(fileContent);
      const section = parseCsvSectionSpec(args.section, records);
      if (!section) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid section "${args.section}" for CSV. Use: rows:1-50 or row:5\nTotal rows: ${Math.max(0, records.length - 1)}`,
            },
          ],
        };
      }
      // only the file's own lines: the header is not next to the rows, so it can't be in old_string
      sectionResult = {
        ...section,
        rawContent: fileLines.slice(section.startLine - 1, section.endLine).join("\n"),
        label: `${section.heading} (columns: ${records[0]?.text.split("\n")[0] ?? ""})`,
      };
    }

    if (!sectionResult) {
      return {
        content: [{ type: "text", text: `Unsupported file type: ${ext}` }],
      };
    }

    const outputLines: string[] = [
      `FILE: ${args.path}`,
      `EDIT SECTION: ${sectionResult.label} [L${sectionResult.startLine}-${sectionResult.endLine}] (${sectionResult.lineCount} lines)`,
      ...(note ? [note] : []),
      "",
      sectionResult.rawContent,
      "",
      `AFTER EDIT: Use read_diff("${args.path}") to verify changes (90% cheaper than re-reading).`,
    ];

    const output = outputLines.join("\n");
    const tokens = estimateTokens(output);

    contextRegistry.trackLoad(absPath, {
      type: "range",
      startLine: sectionResult.startLine,
      endLine: sectionResult.endLine,
      tokens,
    });

    return { content: [{ type: "text", text: output }] };
  }

  // Get file content — also cache for read_diff baseline
  const cached = fileCache.get(absPath);
  let lines: string[];

  if (cached) {
    lines = cached.lines;
  } else {
    const content = await readFile(absPath, "utf-8");
    lines = content.split("\n");

    // Cache the full file so read_diff can use it as baseline after edits
    const fileStat = await stat(absPath);
    const hash = createHash("sha256").update(content).digest("hex");
    fileCache.set(absPath, {
      structure: {
        path: absPath,
        language: "unknown",
        meta: {
          lines: lines.length,
          bytes: content.length,
          lastModified: fileStat.mtimeMs,
          contentHash: hash,
        },
        imports: [],
        exports: [],
        symbols: [],
      },
      content,
      lines,
      mtime: fileStat.mtimeMs,
      hash,
      lastAccess: Date.now(),
    });
  }

  // --- Batch mode: multiple symbols ---
  if (args.symbols && args.symbols.length > 0) {
    const structure = await structureFor(cached, absPath, astIndex);

    const sections: string[] = [];
    sections.push(
      `--- EDIT CONTEXT (BATCH: ${args.symbols.length} symbols) ---`,
    );
    sections.push(`FILE: ${args.path}`);
    sections.push("");

    let resolved_count = 0;
    for (let i = 0; i < args.symbols.length; i++) {
      const symName = args.symbols[i];
      const resolved = await symbolResolver.resolve(symName, structure, absPath);

      if (!resolved) {
        sections.push(
          `=== SYMBOL ${i + 1}/${args.symbols.length}: ${symName} — NOT FOUND ===`,
        );
        sections.push("");
        continue;
      }

      resolved_count++;
      const symbolLines = resolved.endLine - resolved.startLine + 1;
      const MAX_EDIT_LINES = 60;

      let effStart = resolved.startLine;
      let effEnd: number;
      let label: string;

      if (symbolLines <= MAX_EDIT_LINES) {
        effEnd = resolved.endLine;
        label = `${symName} [L${effStart}-${effEnd}] (${symbolLines} lines, full)`;
      } else {
        effEnd = effStart + MAX_EDIT_LINES - 1;
        label = `${symName} [L${effStart}-${resolved.endLine}] (showing first ${MAX_EDIT_LINES} of ${symbolLines} lines)`;
      }

      const rangeStart = Math.max(1, effStart - ctx);
      const rangeEnd = Math.min(lines.length, effEnd + ctx);
      const rawCode = lines.slice(rangeStart - 1, rangeEnd).join("\n");

      sections.push(`=== SYMBOL ${i + 1}/${args.symbols.length}: ${label} ===`);
      sections.push("");
      sections.push(rawCode);
      sections.push("");

      // Track each symbol
      contextRegistry.trackLoad(absPath, {
        type: "symbol",
        symbolName: symName,
        startLine: rangeStart,
        endLine: rangeEnd,
        tokens: estimateTokens(rawCode),
      });
    }

    sections.push("--- END EDIT CONTEXT ---");
    sections.push("");
    sections.push(
      `To edit: use exact text from each section as old_string in Edit tool.`,
    );
    if (resolved_count < args.symbols.length) {
      sections.push(
        `WARNING: ${args.symbols.length - resolved_count} symbol(s) not found. Use smart_read to see available symbols.`,
      );
    }

    const confidenceMeta = assessConfidence({
      symbolResolved: resolved_count > 0,
      fullFile: false,
      truncated: false,
      astAvailable: true,
    });
    sections.push(formatConfidence(confidenceMeta));

    const output = sections.join("\n");
    return { content: [{ type: "text", text: output }] };
  }

  let startLine: number;
  let endLine: number;
  let targetLabel: string;
  // "Class.method" when the resolver knows the owner, for include_callers
  let qualified = args.symbol ?? "";

  if (args.symbol) {
    // Resolve symbol via AST
    const structure = await structureFor(cached, absPath, astIndex);
    const resolved = await symbolResolver.resolve(args.symbol, structure, absPath);

    if (!resolved) {
      return {
        content: [
          {
            type: "text",
            text: `Symbol "${args.symbol}" not found in ${args.path}.\nHINT: Use smart_read("${args.path}") to see available symbols.`,
          },
        ],
      };
    }

    const symbolLines = resolved.endLine - resolved.startLine + 1;
    const MAX_EDIT_LINES = 60;

    qualified = resolved.symbol?.qualifiedName ?? args.symbol;
    startLine = resolved.startLine;

    if (symbolLines <= MAX_EDIT_LINES) {
      endLine = resolved.endLine;
      targetLabel = `${args.symbol} [L${startLine}-${endLine}] (${symbolLines} lines, full)`;
    } else {
      endLine = startLine + MAX_EDIT_LINES - 1;
      targetLabel = `${args.symbol} [L${startLine}-${resolved.endLine}] (showing first ${MAX_EDIT_LINES} of ${symbolLines} lines)`;
    }
  } else if (args.line) {
    if (args.line < 1 || args.line > lines.length) {
      return {
        content: [
          {
            type: "text",
            text: `Line ${args.line} out of range (file has ${lines.length} lines).`,
          },
        ],
      };
    }
    startLine = args.line;
    endLine = args.line;
    targetLabel = `line ${args.line}`;
  } else {
    return {
      content: [
        {
          type: "text",
          text: 'Either "symbol" or "line" must be provided.',
        },
      ],
    };
  }

  // Apply context padding
  const rangeStart = Math.max(1, startLine - ctx);
  const rangeEnd = Math.min(lines.length, endLine + ctx);
  const rangeCount = rangeEnd - rangeStart + 1;

  // Extract RAW code (no line number prefixes — ready for Edit old_string)
  const rawCode = lines.slice(rangeStart - 1, rangeEnd).join("\n");

  const outputLines = [
    `--- EDIT CONTEXT ---`,
    `FILE: ${args.path}`,
    `TARGET: ${targetLabel}`,
    `SHOWING: L${rangeStart}-${rangeEnd} (${rangeCount} lines)`,
    "",
    rawCode,
    "",
    `--- END EDIT CONTEXT ---`,
    "",
    `To edit: use exact text above as old_string in Edit tool.`,
    `For Read requirement: Read("${args.path}", offset=${rangeStart}, limit=${rangeCount})`,
  ];

  // --- Optional enrichment sections ---

  // include_callers: compact caller list via ast-index refs. refs knows bare
  // names only ("Class.method" / "Class::method" → "method"), so a method's
  // caller stays when it is in this file or its file mentions the class
  // outside comments; a plain function's callers are matched by name only.
  if (args.include_callers && args.symbol && !astIndex.isDisabled()) {
    try {
      const parts = qualified.split(/::|\./);
      const bareName = parts.pop()!;
      const owner = parts.pop();
      const refs = await astIndex.refs(bareName, 50);
      const byName = refs.usages.filter((u) => !u.name || u.name === bareName);
      let usages = byName;
      if (owner) {
        usages = [];
        for (const u of byName) {
          const own = resolve(projectRoot, u.path) === absPath;
          const code = own ? null : await codeLines(projectRoot, u.path);
          // unreadable: nothing to check against
          if (own || !code || mentions(code.join("\n"), owner, true)) usages.push(u);
        }
      }
      const callers = usages.slice(0, 5);
      const others = byName.length - usages.length;
      if (callers.length > 0) {
        outputLines.push("");
        outputLines.push(
          usages.length > callers.length
            ? `CALLERS (first ${callers.length} of ${usages.length}${refs.usages.length >= 50 ? "+" : ""}):`
            : `CALLERS (${callers.length}):`,
        );
        for (const c of callers) {
          // ast-index paths are project-relative; never resolve them against the server's cwd
          const relPath = relative(projectRoot, resolve(projectRoot, c.path));
          const ctx = c.context ? ` — ${c.context.trim().slice(0, 80)}` : "";
          outputLines.push(`  ${relPath}:${c.line}${ctx}`);
        }
      } else {
        outputLines.push("");
        outputLines.push("CALLERS: none found");
      }
      if (owner && others > 0) {
        outputLines.push(
          others === 1
            ? `  (1 caller of another \`${bareName}\` left out: its file never mentions ${owner})`
            : `  (${others} callers of another \`${bareName}\` left out: their files never mention ${owner})`,
        );
      } else if (!owner && callers.length > 0) {
        outputLines.push(`  (matched by name only — a same-named \`${bareName}\` elsewhere can appear)`);
      }
    } catch {
      // ast-index unavailable — skip silently
    }
  }

  // include_tests: find related test file and list test names
  if (args.include_tests) {
    const testSection = await findTestSection(absPath, projectRoot, astIndex);
    outputLines.push("");
    outputLines.push(...testSection);
  }

  // include_changes: git diff filtered to target region
  if (args.include_changes) {
    const diffSection = await findChangesSection(
      absPath,
      projectRoot,
      rangeStart,
      rangeEnd,
    );
    outputLines.push("");
    outputLines.push(...diffSection);
  }

  // Confidence metadata
  const confidenceMeta = assessConfidence({
    symbolResolved: !!args.symbol && startLine > 0,
    fullFile: false,
    truncated: false,
    hasCallers: args.include_callers ?? false,
    hasTests: args.include_tests ?? false,
    astAvailable: true,
  });
  outputLines.push(formatConfidence(confidenceMeta));

  // Add post-edit hint (config-gated)
  if (options?.actionableHints !== false) {
    outputLines.push("");
    outputLines.push(
      `AFTER EDIT: Use read_diff("${args.path}") to verify changes (90% cheaper than re-reading the file).`,
    );
  }

  const output = outputLines.join("\n");
  const tokens = estimateTokens(output);

  // Track in context
  contextRegistry.trackLoad(absPath, {
    type: "symbol",
    symbolName: args.symbol ?? `line:${args.line}`,
    startLine: rangeStart,
    endLine: rangeEnd,
    tokens,
  });

  return { content: [{ type: "text", text: output }] };
}

// --- Helper: find related test files and extract test names ---

const TEST_DIRS = ["tests", "test", "__tests__", "spec"];
const MAX_TEST_WALK = 5000;

async function findTestSection(
  absPath: string,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<string[]> {
  const rel = relative(projectRoot, absPath).split(sep).join("/");
  const ext = extname(rel);
  const name = basename(rel, ext);
  const testNames = new Set([
    `${name}.test${ext}`, `${name}.spec${ext}`, `test_${name}${ext}`, `${name}_test${ext}`,
  ]);

  // next to the file, its __tests__/, and anywhere under the project's test dirs
  const found = new Set<string>();
  const dir = dirname(rel);
  for (const d of [dir, `${dir}/__tests__`]) {
    for (const t of testNames) {
      const p = d === "." ? t : `${d}/${t}`;
      if (await access(join(projectRoot, p)).then(() => true, () => false)) found.add(p);
    }
  }
  let budget = MAX_TEST_WALK;
  const walk = async (d: string): Promise<void> => {
    let items;
    try {
      items = await readdir(join(projectRoot, d), { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (--budget < 0) return;
      const p = `${d}/${it.name}`;
      if (it.isDirectory()) {
        if (it.name !== "node_modules" && !it.name.startsWith(".")) await walk(p);
      } else if (testNames.has(it.name)) {
        found.add(p);
      }
    }
  };
  for (const root of TEST_DIRS) await walk(root);

  if (found.size === 0) {
    return [`TESTS: none found (looked for ${name}.test${ext} / ${name}.spec${ext} next to the file and under ${TEST_DIRS.join("/, ")}/)`];
  }

  const lines: string[] = [];
  for (const testRelPath of found) {
    lines.push(`TESTS: ${testRelPath}`);
    if (astIndex.isDisabled()) continue;
    try {
      const outline = await astIndex.outline(join(projectRoot, testRelPath));
      for (const sym of outline?.symbols ?? []) {
        lines.push(`  ${sym.kind} ${sym.name}`);
        for (const child of sym.children ?? []) {
          lines.push(`    ${child.kind} ${child.name}`);
        }
      }
    } catch {
      // outline failed — just show file path
    }
  }
  return lines;
}

// --- Helper: git diff filtered to target region ---

async function findChangesSection(
  absPath: string,
  projectRoot: string,
  rangeStart: number,
  rangeEnd: number,
): Promise<string[]> {
  const MAX_DIFF_LINES = 30;

  try {
    // Try unstaged changes first
    let diffOutput = "";
    let diffLabel = "unstaged";

    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "HEAD", "--", absPath],
        {
          cwd: projectRoot,
          timeout: 5000,
        },
      );
      diffOutput = stdout;
    } catch {
      // git not available or not a repo
      return ["RECENT CHANGES: unavailable (not a git repo)"];
    }

    // If no unstaged changes, try last commit
    if (!diffOutput.trim()) {
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["diff", "HEAD~1", "--", absPath],
          {
            cwd: projectRoot,
            timeout: 5000,
          },
        );
        diffOutput = stdout;
        diffLabel = "last commit";
      } catch {
        // no previous commit
      }
    }

    if (!diffOutput.trim()) {
      // git diff is silent for a file git does not track
      try {
        const { stdout } = await execFileAsync("git", ["ls-files", "--", absPath], {
          cwd: projectRoot,
          timeout: 5000,
        });
        if (!stdout.trim()) return ["RECENT CHANGES: untracked (new file, not in git yet)"];
      } catch {
        // fall through
      }
      return ["RECENT CHANGES: none (file unchanged)"];
    }

    // Filter hunks to those overlapping with target range
    const relevantLines = filterDiffHunks(diffOutput, rangeStart, rangeEnd);

    if (relevantLines.length === 0) {
      return ["RECENT CHANGES: none in target region"];
    }

    const lines: string[] = [`RECENT CHANGES (${diffLabel}):`];
    const trimmed = relevantLines.slice(0, MAX_DIFF_LINES);
    for (const line of trimmed) {
      lines.push(`  ${line}`);
    }
    if (relevantLines.length > MAX_DIFF_LINES) {
      lines.push(`  ... ${relevantLines.length - MAX_DIFF_LINES} more lines`);
    }
    return lines;
  } catch {
    return ["RECENT CHANGES: unavailable"];
  }
}

/** Filter diff output to only hunks overlapping [rangeStart, rangeEnd]. */
function filterDiffHunks(
  diff: string,
  rangeStart: number,
  rangeEnd: number,
): string[] {
  const allLines = diff.split("\n");
  const result: string[] = [];
  let inRelevantHunk = false;

  for (const line of allLines) {
    // Hunk header: @@ -a,b +c,d @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      const hunkStart = parseInt(hunkMatch[1], 10);
      const hunkLen = parseInt(hunkMatch[2] ?? "1", 10);
      const hunkEnd = hunkStart + hunkLen - 1;
      // Check overlap with target range
      inRelevantHunk = hunkStart <= rangeEnd && hunkEnd >= rangeStart;
      if (inRelevantHunk) {
        result.push(line);
      }
      continue;
    }

    // Skip diff metadata lines (diff --git, index, ---, +++)
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      continue;
    }

    if (
      inRelevantHunk &&
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))
    ) {
      result.push(line);
    }
  }

  return result;
}
