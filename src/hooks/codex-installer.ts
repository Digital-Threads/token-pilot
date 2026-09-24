/**
 * Codex CLI hook installer.
 *
 * Codex grew the same lifecycle-hook protocol Claude Code uses: hooks live in
 * `~/.codex/hooks.json` or `<repo>/.codex/hooks.json`, each event holds
 * `{matcher?, hooks: [{type: "command", command}]}` entries, and a hook blocks
 * a call by printing `hookSpecificOutput.permissionDecision: "deny"` with a
 * `permissionDecisionReason` — or by exiting 2 with the reason on stderr.
 * Those are the exact shapes our decide-functions already emit, so the
 * handlers are reused unchanged.
 * Reference: https://developers.openai.com/codex/hooks
 *
 * Only the events whose payload matches what our handlers read are wired:
 *
 *   PreToolUse   / `Bash` — `tool_input.command`, the same field Claude Code
 *                           sends. Codex has no file-read tool at all: the
 *                           model reads through the shell, which is exactly
 *                           what the bash rules already intercept (`cat`,
 *                           `grep -r`, unbounded `git log` / `git diff`).
 *   PostToolUse  / `Bash` — the advisory after a heavy command.
 *   SessionStart          — `additionalContext`, same shape.
 *   UserPromptSubmit      — `additionalContext`, same shape.
 *
 * Deliberately left out: `apply_patch` (Codex sends a patch string where the
 * edit gate expects `file_path` / `old_string`) and `Agent` (Codex's
 * `spawn_agent` arguments are not Claude Code's `subagent_type` /
 * `description`, so the router would match against nothing). Wiring either
 * would produce confident advice about a payload we have not read.
 *
 * Codex does not run a freshly written hook file until the user reviews it
 * with `/hooks` once — the installer says so instead of implying the hooks
 * are already live.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildHookCommand, type HookInstallOptions } from "./installer.js";

export interface CodexHookEntry {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string }>;
}

export interface CodexHookConfig {
  hooks: Record<string, CodexHookEntry[]>;
}

export interface CodexInstallResult {
  installed: boolean;
  fatal: boolean;
  message: string;
}

export interface CodexUninstallResult {
  removed: boolean;
  fatal: boolean;
  message: string;
}

/**
 * Every hook action we ever emit. Used to recognise our own entries in a
 * settings file we are merging into — by the action they dispatch, not by the
 * path they were installed from. A dev checkout, an npx cache and a plugin
 * copy all have different paths but the same actions.
 */
const OUR_ACTIONS = [
  "hook-pre-bash",
  "hook-post-bash",
  "hook-session-start",
  "hook-user-prompt",
  "hook-read",
  "hook-edit",
  "hook-pre-grep",
  "hook-pre-task",
  "hook-post-task",
  "hook-subagent-stop",
  "hook-bootstrap",
];

const isOurCommand = (command: unknown): boolean =>
  typeof command === "string" &&
  OUR_ACTIONS.some((action) => command.includes(action));

const isOurEntry = (entry: unknown): boolean =>
  !!entry &&
  typeof entry === "object" &&
  Array.isArray((entry as CodexHookEntry).hooks) &&
  (entry as CodexHookEntry).hooks.some((hook) => isOurCommand(hook?.command));

/** The hook set token-pilot installs into Codex. */
export function createCodexHookConfig(
  options?: HookInstallOptions,
): CodexHookConfig {
  const entry = (action: string): CodexHookEntry["hooks"] => [
    { type: "command", command: buildHookCommand(action, options) },
  ];

  return {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: entry("hook-pre-bash") }],
      PostToolUse: [{ matcher: "Bash", hooks: entry("hook-post-bash") }],
      SessionStart: [{ hooks: entry("hook-session-start") }],
      UserPromptSubmit: [{ hooks: entry("hook-user-prompt") }],
    },
  };
}

/**
 * Merge our hooks into `<codexDir>/hooks.json`, creating the directory when
 * it does not exist. Foreign entries are kept; our own are replaced, so a
 * re-install never doubles a hook.
 */
export async function installCodexHook(
  codexDir: string,
  options?: HookInstallOptions,
): Promise<CodexInstallResult> {
  const settingsPath = resolve(codexDir, "hooks.json");
  const ours = createCodexHookConfig(options);

  let existing: { hooks?: Record<string, unknown> } = {};
  try {
    const raw = await readFile(settingsPath, "utf-8");
    try {
      existing = JSON.parse(raw);
    } catch {
      return {
        installed: false,
        fatal: true,
        message: `${settingsPath} exists but contains invalid JSON. Fix it before installing hooks.`,
      };
    }
  } catch (err: unknown) {
    if ((err as { code?: string })?.code !== "ENOENT") {
      return {
        installed: false,
        fatal: true,
        message: `Cannot read ${settingsPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  const merged: Record<string, CodexHookEntry[]> = {};
  for (const [event, entries] of Object.entries(existing.hooks ?? {})) {
    const foreign = (Array.isArray(entries) ? entries : []).filter(
      (entry) => !isOurEntry(entry),
    ) as CodexHookEntry[];
    if (foreign.length) merged[event] = foreign;
  }
  for (const [event, entries] of Object.entries(ours.hooks)) {
    merged[event] = [...(merged[event] ?? []), ...entries];
  }

  try {
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ ...existing, hooks: merged }, null, 2) + "\n",
    );
  } catch (err: unknown) {
    return {
      installed: false,
      fatal: true,
      message: `Failed to write ${settingsPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  return {
    installed: true,
    fatal: false,
    message:
      `Codex hooks written to ${settingsPath}.\n` +
      "Codex will not run them until you review them once — open Codex and " +
      "run `/hooks` to trust the current definition.",
  };
}

/** Remove our entries from `<codexDir>/hooks.json`, leaving foreign ones. */
export async function uninstallCodexHook(
  codexDir: string,
): Promise<CodexUninstallResult> {
  const settingsPath = resolve(codexDir, "hooks.json");

  let parsed: { hooks?: Record<string, unknown> };
  try {
    parsed = JSON.parse(await readFile(settingsPath, "utf-8"));
  } catch {
    return { removed: false, fatal: false, message: "No Codex hooks to remove." };
  }

  const kept: Record<string, CodexHookEntry[]> = {};
  let removed = false;
  for (const [event, entries] of Object.entries(parsed.hooks ?? {})) {
    const list = Array.isArray(entries) ? entries : [];
    const foreign = list.filter((entry) => !isOurEntry(entry));
    if (foreign.length !== list.length) removed = true;
    if (foreign.length) kept[event] = foreign as CodexHookEntry[];
  }

  if (!removed) {
    return { removed: false, fatal: false, message: "No Codex hooks to remove." };
  }

  try {
    await writeFile(
      settingsPath,
      JSON.stringify({ ...parsed, hooks: kept }, null, 2) + "\n",
    );
  } catch (err: unknown) {
    return {
      removed: false,
      fatal: true,
      message: `Failed to write ${settingsPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  return {
    removed: true,
    fatal: false,
    message: `Removed token-pilot hooks from ${settingsPath}.`,
  };
}
