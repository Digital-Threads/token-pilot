/**
 * v0.34.0 — `runHookSafely` / `runHookEntryPoint`.
 *
 * Every token-pilot hook used to wrap its own try/catch. When the
 * branch broke (B2 stale binary, B8 bad cwd, B10 ast-index init
 * race), throws were swallowed silently and the user saw "nothing
 * happens". This wrapper centralises the discipline:
 *
 *   - Run the hook body
 *   - On throw → record one structured `HookErrorRecord` to the
 *     user-level error log
 *   - Optionally measure duration and emit a `diagnostic` event
 *     (Pack 3 — timing)
 *   - ALWAYS exit 0 — Claude Code must never see a hook error
 *     because that aborts the user's tool call.
 *
 * Hooks themselves keep responsibility for emitting domain-level
 * diagnostics (matcher empty, WSL reject, etc.) — this wrapper is
 * the safety net for unexpected throws.
 */

import { writeSync } from "node:fs";
import { appendError, classifyError, type ErrorLevel } from "../core/error-log.js";

/**
 * Write a hook's answer to stdout. Claude Code can hand a hook (an async
 * one in particular) a non-blocking pipe, where a synchronous write fails
 * with EAGAIN while the pipe is full. Retry briefly, then drop the output:
 * a lost hint is not a hook error. Any other failure (EPIPE — nobody reads)
 * drops it too.
 */
export function writeStdout(
  text: string,
  write: (buf: Buffer) => number = (buf) => writeSync(1, buf),
): void {
  let buf = Buffer.from(text);
  let stalls = 0;

  while (buf.length > 0 && stalls < 50) {
    let written = 0;
    try {
      written = write(buf);
    } catch (err) {
      if ((err as { code?: string })?.code !== "EAGAIN") return;
    }

    if (written > 0) {
      buf = buf.subarray(written);
      continue;
    }

    stalls++;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

export interface RunHookOptions {
  /** Hook name (matcher in hooks.json — e.g. "hook-pre-task"). */
  hook: string;
  /** Optional safe summary of the hook input — sanitised by caller. */
  inputSummary?: Record<string, unknown>;
  /** Plugin version, captured by caller and forwarded to the log. */
  pluginVersion?: string;
}

/**
 * Run a hook body and swallow any throw into the structured error log.
 * Returns true on success, false on caught error — useful when the
 * caller still wants to take a fallback action (e.g. emit a generic
 * permissionDecision to Claude before exiting).
 */
export async function runHookSafely(
  options: RunHookOptions,
  fn: () => Promise<void> | void,
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    const e = err as Error & { stack?: string; code?: string };
    await appendError({
      ts: Date.now(),
      hook: options.hook,
      level: "error" as ErrorLevel,
      code: classifyError(err),
      msg: e?.message ?? String(err),
      stack: e?.stack,
      input: options.inputSummary,
      pluginVersion: options.pluginVersion,
      nodeVersion: process.version,
      platform: process.platform,
    });
    return false;
  }
}

/**
 * The full entry-point wrapper used by `index.ts` cases. Wraps
 * `runHookSafely` and additionally guarantees `process.exit(0)` at
 * the end so a stray throw cannot leak a non-zero status to Claude.
 *
 * Pack 3: optionally measures duration and forwards it to the
 * caller via `onTiming` so the timing diagnostic can be emitted
 * after the hook body decided what to log to hook-events.jsonl.
 */
export async function runHookEntryPoint(
  options: RunHookOptions & { onTiming?: (durationMs: number) => Promise<void> | void },
  fn: () => Promise<void> | void,
): Promise<never> {
  const started = Date.now();
  await runHookSafely(options, fn);
  const durationMs = Date.now() - started;
  if (options.onTiming) {
    try {
      await options.onTiming(durationMs);
    } catch {
      /* timing emit must never affect exit */
    }
  }
  process.exit(0);
}
