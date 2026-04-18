/**
 * TP-89n — persist arbitrary research text so it survives compaction.
 *
 * `token-pilot save-doc <name>` reads text from stdin (or --content flag)
 * and writes it to `.token-pilot/docs/<name>.md`. `token-pilot list-docs`
 * enumerates what's been saved. Later, agents can re-read the file with
 * `read_range` / `smart_read` instead of re-fetching the external source.
 *
 * Safety: name must be a slug (no path separators, no traversal, no
 * whitespace/control chars). Overwrite is explicit.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

export const DOCS_SUBDIR = ".token-pilot/docs";

const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function normalizeDocName(raw: string): string {
  if (!raw) throw new Error("invalid doc name: empty");
  const trimmed = raw.endsWith(".md") ? raw.slice(0, -3) : raw;
  if (!NAME_RE.test(trimmed)) {
    throw new Error(
      `invalid doc name: ${JSON.stringify(raw)} — use [A-Za-z0-9._-] only`,
    );
  }
  return trimmed;
}

export interface SaveDocInput {
  projectRoot: string;
  name: string;
  content: string;
  overwrite?: boolean;
}

export interface SaveDocResult {
  saved: boolean;
  path?: string;
  reason?: string;
}

export async function saveDoc(input: SaveDocInput): Promise<SaveDocResult> {
  const name = normalizeDocName(input.name);
  if (!input.content) {
    return { saved: false, reason: "content is empty" };
  }
  const dir = join(input.projectRoot, DOCS_SUBDIR);
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.md`);

  if (!input.overwrite) {
    try {
      await fs.stat(path);
      return {
        saved: false,
        path,
        reason: `doc already exists at ${path}; pass --overwrite to replace`,
      };
    } catch {
      /* not present — proceed */
    }
  }

  await fs.writeFile(path, input.content);
  return { saved: true, path };
}

export interface DocEntry {
  name: string;
  path: string;
  bytes: number;
  mtimeMs: number;
}

export async function listDocs(projectRoot: string): Promise<DocEntry[]> {
  const dir = join(projectRoot, DOCS_SUBDIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: DocEntry[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const full = join(dir, name);
    try {
      const s = await fs.stat(full);
      if (!s.isFile()) continue;
      out.push({
        name: name.slice(0, -3),
        path: full,
        bytes: s.size,
        mtimeMs: s.mtimeMs,
      });
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * CLI entry — returns exit code.
 * Usage:
 *   token-pilot save-doc <name> [--overwrite] [--content "text"]
 *   token-pilot list-docs
 * When --content is absent, reads from stdin.
 */
export async function handleSaveDocCli(args: string[]): Promise<number> {
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) {
    process.stderr.write(
      'Usage: token-pilot save-doc <name> [--overwrite] [--content "text"]\n',
    );
    return 1;
  }
  const overwrite = args.includes("--overwrite");
  const contentIdx = args.indexOf("--content");
  let content: string;
  if (contentIdx >= 0 && args[contentIdx + 1] !== undefined) {
    content = args[contentIdx + 1];
  } else {
    content = await readAllStdin();
  }

  try {
    const res = await saveDoc({
      projectRoot: process.cwd(),
      name,
      content,
      overwrite,
    });
    if (res.saved) {
      process.stdout.write(`Saved: ${res.path}\n`);
      return 0;
    }
    process.stderr.write(`Not saved: ${res.reason ?? "unknown reason"}\n`);
    return 1;
  } catch (err) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

export async function handleListDocsCli(): Promise<number> {
  const docs = await listDocs(process.cwd());
  if (docs.length === 0) {
    process.stdout.write("No saved docs.\n");
    return 0;
  }
  for (const d of docs) {
    const kb = (d.bytes / 1024).toFixed(1);
    process.stdout.write(`${d.name}\t${kb} KB\t${d.path}\n`);
  }
  return 0;
}

async function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
