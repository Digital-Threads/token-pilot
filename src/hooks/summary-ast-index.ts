/**
 * Primary hook-summary parser: spawns the bundled `ast-index` binary with
 * `ast-index outline <path>` and maps the returned outline entries to
 * SignalLine[]. Returns null when the binary is unavailable or the
 * subprocess fails — the pipeline then falls back to regex / head+tail.
 *
 * Short-lived: the hook process spawns the binary once per invocation.
 * The long-running AstIndexClient used by the MCP server is intentionally
 * NOT reused here to keep the hook's startup cost minimal.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findBinary } from "../ast-index/binary-manager.js";
import { parseOutlineText } from "../ast-index/parser.js";
import type { AstIndexOutlineEntry } from "../ast-index/types.js";
import type { HookSummary, SignalLine } from "./summary-types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_TEXT_LEN = 140;

type ExecFn = (
  binary: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface AstIndexSummaryOptions {
  /** Explicit binary path. `null` means "no binary available" → returns null. Omit to resolve via findBinary. */
  binaryPath?: string | null;
  /** Subprocess timeout (ms). Default 4000. */
  timeoutMs?: number;
  /** Injectable spawner for tests. */
  exec?: ExecFn;
}

function extractExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1 || lastDot === filePath.length - 1) return "";
  const ext = filePath.slice(lastDot + 1).toLowerCase();
  if (ext.includes("/") || ext.includes("\\")) return "";
  return ext;
}

function truncate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_TEXT_LEN) return trimmed;
  return trimmed.slice(0, MAX_TEXT_LEN - 1) + "…";
}

function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const charEstimate = Math.ceil(text.length / 4);
  const whitespaceRatio = (text.match(/\s/g)?.length ?? 0) / text.length;
  const adjustment = 1 - whitespaceRatio * 0.3;
  return Math.ceil(charEstimate * adjustment);
}

const defaultExec: ExecFn = async (binary, args, opts) => {
  const { stdout, stderr } = await execFileAsync(binary, args, {
    timeout: opts.timeout,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

/**
 * Resolve the binary path unless the caller already supplied one (including
 * `null` to force "not available" for tests).
 */
async function resolveBinaryPath(
  explicit: string | null | undefined,
): Promise<string | null> {
  if (explicit !== undefined) return explicit;
  try {
    const status = await findBinary(null);
    return status?.available ? status.path : null;
  } catch {
    return null;
  }
}

function flattenEntries(entries: AstIndexOutlineEntry[]): SignalLine[] {
  const signals: SignalLine[] = [];

  function walk(entry: AstIndexOutlineEntry, depth: number): void {
    const indent = depth > 0 ? "  ".repeat(depth) : "";
    const label =
      entry.signature && entry.signature.length > 0
        ? entry.signature
        : entry.name;
    const text = truncate(`${indent}${entry.kind} ${label}`);
    signals.push({
      line: entry.start_line,
      kind: entry.visibility === "public" ? "export" : "declaration",
      text,
    });
    if (entry.children && entry.children.length > 0) {
      for (const child of entry.children) walk(child, depth + 1);
    }
  }

  for (const entry of entries) walk(entry, 0);
  return signals;
}

export async function parseAstIndexSummary(
  content: string,
  filePath: string,
  options: AstIndexSummaryOptions = {},
): Promise<HookSummary | null> {
  const binaryPath = await resolveBinaryPath(options.binaryPath);
  if (!binaryPath) return null;

  const exec = options.exec ?? defaultExec;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let outlineText: string;
  try {
    const { stdout } = await exec(binaryPath, ["outline", filePath], {
      timeout,
    });
    outlineText = stdout;
  } catch {
    return null;
  }

  let entries: AstIndexOutlineEntry[];
  try {
    entries = parseOutlineText(outlineText);
  } catch {
    return null;
  }

  if (!entries || entries.length === 0) return null;

  const signals = flattenEntries(entries);
  if (signals.length === 0) return null;

  const language = extractExtension(filePath);
  const totalLines = content.split("\n").length;
  const estimatedTokens = estimateTokens(content);

  return {
    signals,
    totalLines,
    estimatedTokens,
    language,
  };
}
