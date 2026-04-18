/**
 * Path-safety check used by the PreToolUse hook before reading any file.
 *
 * Resolves both the target file and the project root through realpath
 * (so symlinks cannot escape the sandbox), then requires the resolved
 * file path to fall inside the resolved project directory. On any error
 * (missing file, permission denied, realpath loop) we refuse — the hook
 * will then pass-through rather than risk reading an attacker-crafted
 * path.
 *
 * Sibling directories that share a common prefix (e.g. `/tmp/proj`
 * vs `/tmp/proj-evil`) are rejected by forcing a path-separator on the
 * normalised root.
 */

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

export function isPathWithinProject(
  filePath: string,
  projectRoot: string,
): boolean {
  if (!filePath || !projectRoot) return false;

  let resolvedFile: string;
  let resolvedRoot: string;
  try {
    resolvedFile = realpathSync(resolve(filePath));
    resolvedRoot = realpathSync(resolve(projectRoot));
  } catch {
    return false;
  }

  if (resolvedFile === resolvedRoot) return true;

  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  return resolvedFile.startsWith(prefix);
}
