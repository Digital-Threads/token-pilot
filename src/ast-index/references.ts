/**
 * Does a declaration really reference a name? ast-index names the nearest
 * symbol above a call site — or above a mention in a comment — as the
 * "caller"; from 3.56 it names the declaration around a mention in a
 * string too. So call_tree and explore check the caller's own code.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { codeOnly } from "./enricher.js";

/** Lines of a project file with comments and strings blanked, or null when it cannot be read. */
export async function codeLines(projectRoot: string, path: string): Promise<string[] | null> {
  try {
    const raw = await readFile(resolve(projectRoot, path), "utf-8");
    return codeOnly(raw, path).split("\n");
  } catch {
    return null;
  }
}

/** The declaration at `line` (1-based) through the line that closes it by indentation. */
export function blockAt(lines: string[], line: number): string {
  const indent = (s: string) => s.length - s.trimStart().length;
  const start = Math.max(0, line - 1);
  const base = indent(lines[start] ?? "");
  const body = [lines[start] ?? ""];

  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== "" && indent(l) <= base) {
      if (/^\s*[}\])]/.test(l)) body.push(l);
      break;
    }
    body.push(l);
  }

  return body.join("\n");
}

/** True when `block` names `name` as a whole word; after a `.` only when `member`. */
export function mentions(block: string, name: string, member: boolean): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = member ? "(^|[^\\w$])" : "(^|[^\\w$.])";

  return new RegExp(`${before}${escaped}(?![\\w$])`).test(block);
}
