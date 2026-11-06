/**
 * v0.30.0 — PreToolUse:Edit/MultiEdit/Write enforcement.
 *
 * Background: tool-audit data across three real projects (2026-04-24)
 * showed Codex calling `read_for_edit` at 33% of its MCP volume while
 * Claude sat at 0-1% despite our MCP instructions marking it MANDATORY.
 * Text rules alone don't flip trained agent instincts. The pattern that
 * did move Claude — pre-grep → find_usages — is hook-based deny.
 *
 * This hook closes the gap: before Claude executes Edit/MultiEdit/Write
 * on an existing code file, we check a shared prep-state file that
 * read_for_edit updates on every call. If the file isn't prepared we
 * block (deny) or warn (advisory), depending on TOKEN_PILOT_MODE.
 *
 * Scope rules, in order:
 *   1. Non-code files            → allow (config, markdown, etc.)
 *   2. Write on non-existent file → allow (new-file creation is fine)
 *   3. TOKEN_PILOT_BYPASS=1      → allow (escape hatch)
 *   4. File already prepared     → allow
 *   5. TOKEN_PILOT_MODE=strict   → deny with actionable message
 *   6. Otherwise                 → allow, silently: read_for_edit is advice
 *      in its own tool description, and an Edit after Read works
 *
 * The decide function is pure — no I/O, no process.env reads — so it is
 * trivially unit-testable. All side effects (existsSync, state read,
 * enforcement-mode env) are resolved in the thin wrapper before the call.
 */

import type { EnforcementMode } from "../server/enforcement-mode.js";
import { toolPrefix } from "../core/tool-names.js";

export interface PreEditInput {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    [k: string]: unknown;
  };
}

export type PreEditDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string };

export interface PreEditContext {
  /** Enforcement mode from TOKEN_PILOT_MODE */
  mode: EnforcementMode;
  /** File extension is a code file we care about */
  isCodeFile: boolean;
  /** The target file already exists on disk */
  fileExists: boolean;
  /** read_for_edit was called for this file recently */
  isPrepared: boolean;
  /** TOKEN_PILOT_BYPASS=1 set in env */
  bypassed: boolean;
  /**
   * The file lies outside the project. read_for_edit refuses such paths, so
   * gating them would leave strict mode no way forward.
   */
  outsideProject?: boolean;
}

/**
 * Pure decision function. Caller resolves all context (FS, env, state)
 * beforehand so this stays a deterministic mapping input → decision.
 */
export function decidePreEdit(
  input: PreEditInput,
  ctx: PreEditContext,
): PreEditDecision {
  const toolName = input.tool_name ?? "";
  // Only Edit and MultiEdit touch a file partially with an old_string that
  // MUST match disk byte-for-byte — those are the calls read_for_edit
  // actually prepares. Write replaces the whole file (new content, no
  // old_string) so enforcing prep on Write is overreach: blocks legit
  // script regeneration / template overwrites that never needed prep.
  // Pre-v0.30.3 we blocked Write too; that was wrong. Rolled back.
  if (toolName !== "Edit" && toolName !== "MultiEdit") {
    return { kind: "allow" };
  }

  const filePath = input.tool_input?.file_path;
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { kind: "allow" };
  }

  // Non-code files: config, markdown, JSON — Read-based edit-prep doesn't
  // carry the same value, skip enforcement.
  if (!ctx.isCodeFile) return { kind: "allow" };

  // Non-existent files — Edit/MultiEdit will error downstream in Claude Code
  // itself. Nothing for us to add.
  if (!ctx.fileExists) return { kind: "allow" };

  // Explicit escape hatch. Documented as TOKEN_PILOT_BYPASS=1.
  if (ctx.bypassed) return { kind: "allow" };

  // Already prepared, or a file read_for_edit cannot prepare → allow.
  if (ctx.isPrepared || ctx.outsideProject) return { kind: "allow" };

  const suggestion = `${toolPrefix()}read_for_edit(path="${filePath}", symbol="<target>")`;

  // v0.30.4 — only TOKEN_PILOT_MODE=strict produces a hard deny. The old
  // "deny is default = hard-block every un-prepped Edit" was overreach:
  // two real-project deadlocks reported on 2026-04-24 (MCP briefly
  // disconnected, and an agent that simply forgot to prep). The cost of a
  // false deny (stuck session, user scrambles for TOKEN_PILOT_BYPASS) is
  // much worse than the cost of a missed nudge. Strict mode still exists
  // for users who want the old hard-block behaviour.
  if (ctx.mode === "strict") {
    const reason =
      `File "${filePath}" was not prepared with read_for_edit. ` +
      `Call ${suggestion} FIRST to obtain the exact old_string for Edit — ` +
      `this is the canonical flow. Building old_string from smart_read or Read ` +
      `snippets diverges from disk (whitespace, line-number prefixes) and Edit ` +
      `silently mismatches. ` +
      `If read_for_edit is unavailable, ask the user: they can restart Claude Code ` +
      `with TOKEN_PILOT_MODE=deny (no check) or TOKEN_PILOT_BYPASS=1.`;
    return { kind: "deny", reason };
  }

  // The default and advisory modes let it through: read_for_edit is advice
  // in its own tool description, and an Edit after Read works.
  return { kind: "allow" };
}

/**
 * Render the Claude Code hook JSON response.
 *
 * - allow   → no output (hook passes through with no side-effect)
 * - deny    → permissionDecision=deny + reason
 */
export function renderPreEditOutput(decision: PreEditDecision): string | null {
  if (decision.kind === "allow") return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  });
}
