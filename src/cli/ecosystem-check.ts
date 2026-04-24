/**
 * Ecosystem coverage check — detects which complementary tools are
 * installed alongside token-pilot.
 *
 * Scope: only tools whose author has a stable install story and whose
 * problem-space is truly disjoint from ours (we don't recommend things
 * that overlap our own tools/list).
 *
 * Status options:
 *   - "installed"    — detected on disk, ready to use
 *   - "not-installed" — not detected in any known install location
 *   - "unknown"      — couldn't check (permission denied, unusual OS, etc.)
 *
 * Pure read-only. No network calls. Fast enough to run from `doctor`
 * on every invocation.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type EcosystemToolId = "caveman" | "cavemem" | "context-mode";

export interface EcosystemToolStatus {
  id: EcosystemToolId;
  name: string;
  role: string;
  status: "installed" | "not-installed" | "unknown";
  detectedAt: string | null;
  installHint: string;
  repo: string;
}

/**
 * Conventional Claude Code plugin cache for a given plugin name.
 * Matches the pattern token-pilot itself lives under.
 */
function claudePluginCacheDir(plugin: string): string {
  return join(homedir(), ".claude", "plugins", "cache", plugin);
}

/**
 * Conventional Gemini CLI extensions dir for a given extension name.
 */
function geminiExtensionDir(ext: string): string {
  return join(homedir(), ".gemini", "extensions", ext);
}

/**
 * Probe a list of candidate paths; return the first that exists.
 * Any FS error → return null (caller reports "unknown").
 */
function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // Permission denied or similar — move on, the caller decides how
      // to report this. We don't want a doctor run to crash because one
      // probe couldn't stat a path.
      continue;
    }
  }
  return null;
}

function checkCaveman(): EcosystemToolStatus {
  const candidates = [
    claudePluginCacheDir("caveman"),
    geminiExtensionDir("caveman"),
    // Codex + Cursor install into project-local dirs — out of scope for a
    // doctor run whose cwd is the user's code. If the user ran caveman
    // through `npx skills`, the marker is usually `.claude/skills/caveman`
    // or `.cursor/rules/caveman.mdc` — also project-local, same reason.
  ];
  const detected = firstExisting(candidates);
  return {
    id: "caveman",
    name: "caveman",
    role: "Output compression (terse-speak skill) — cuts ~75% of Claude's response prose",
    status: detected ? "installed" : "not-installed",
    detectedAt: detected,
    installHint:
      "claude plugin marketplace add JuliusBrussee/caveman && claude plugin install caveman@caveman",
    repo: "https://github.com/JuliusBrussee/caveman",
  };
}

function checkCavemem(): EcosystemToolStatus {
  const candidates = [
    claudePluginCacheDir("cavemem"),
    geminiExtensionDir("cavemem"),
  ];
  const detected = firstExisting(candidates);
  return {
    id: "cavemem",
    name: "cavemem",
    role: "Cross-session memory — remember context across restarts",
    status: detected ? "installed" : "not-installed",
    detectedAt: detected,
    installHint: "see https://github.com/JuliusBrussee/cavemem",
    repo: "https://github.com/JuliusBrussee/cavemem",
  };
}

function checkContextMode(): EcosystemToolStatus {
  const candidates = [
    claudePluginCacheDir("context-mode"),
    claudePluginCacheDir("claude-context-mode"),
  ];
  const detected = firstExisting(candidates);
  return {
    id: "context-mode",
    name: "context-mode",
    role: "Sandbox executor — runs shell/python/js, only stdout enters context",
    status: detected ? "installed" : "not-installed",
    detectedAt: detected,
    installHint: "see https://github.com/mksglu/claude-context-mode",
    repo: "https://github.com/mksglu/claude-context-mode",
  };
}

/**
 * Run all ecosystem checks. Order is deterministic — the checks are cheap
 * and we want the doctor output to be stable across runs.
 */
export function checkEcosystem(): EcosystemToolStatus[] {
  return [checkCaveman(), checkContextMode(), checkCavemem()];
}

/**
 * Render a block suitable for appending to `token-pilot doctor` output.
 * Returns null when every tool is installed — no point printing a
 * noisy "all green" block when the user has nothing to act on.
 */
export function formatEcosystemBlock(
  statuses: EcosystemToolStatus[],
): string | null {
  const missing = statuses.filter((s) => s.status === "not-installed");
  const installed = statuses.filter((s) => s.status === "installed");

  // When everything is green we stay silent — the doctor surface is busy
  // enough. Users can still get the full map from `docs/ecosystem.md`.
  if (missing.length === 0 && installed.length === 0) return null;

  const lines: string[] = ["── ecosystem coverage ──"];

  if (installed.length > 0) {
    for (const s of installed) {
      lines.push(`  ✓ ${s.name.padEnd(14)} ${s.role}`);
    }
  }
  for (const s of missing) {
    lines.push(`  ○ ${s.name.padEnd(14)} missing — ${s.role}`);
    lines.push(`    install:     ${s.installHint}`);
  }

  if (missing.length > 0) {
    lines.push("");
    lines.push(
      `  token-pilot owns INPUT tokens. Each tool above owns a different`,
    );
    lines.push(
      `  half of a session — they do not overlap. See docs/ecosystem.md.`,
    );
  }

  return lines.join("\n");
}

// ───────────────────────────────────────────────────────────────────
// Statusline badge — optional Claude Code status-bar indicator
// ───────────────────────────────────────────────────────────────────

export type StatuslineStatus =
  | "configured-chain" // points at our chain wrapper — best
  | "configured-tp-only" // points at tp-statusline.sh directly
  | "configured-caveman-only" // points at caveman-statusline.sh — our TP badge missing
  | "configured-other" // some third-party statusLine — we leave it alone
  | "not-configured" // no statusLine block at all
  | "unknown"; // settings.json unreadable / not JSON

export interface StatuslineCheckResult {
  status: StatuslineStatus;
  configPath: string;
  currentCommand: string | null;
}

/**
 * Parse `~/.claude/settings.json` and report whether a statusline is
 * wired to token-pilot's own script. Used by `doctor` to nudge toward
 * the chain wrapper when appropriate. Never throws.
 */
export function checkStatusline(): StatuslineCheckResult {
  const configPath = join(homedir(), ".claude", "settings.json");
  const empty = {
    status: "not-configured" as const,
    configPath,
    currentCommand: null,
  };
  if (!existsSync(configPath)) return empty;

  let text: string;
  try {
    text = readFileSync(configPath, "utf-8");
  } catch {
    return { status: "unknown", configPath, currentCommand: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "unknown", configPath, currentCommand: null };
  }

  const sl = (parsed as { statusLine?: { command?: string } } | null)
    ?.statusLine;
  if (!sl || typeof sl.command !== "string") return empty;

  const cmd = sl.command;
  if (cmd.includes("statusline-chain.sh")) {
    return { status: "configured-chain", configPath, currentCommand: cmd };
  }
  if (cmd.includes("tp-statusline.sh")) {
    return { status: "configured-tp-only", configPath, currentCommand: cmd };
  }
  if (cmd.includes("caveman-statusline.sh")) {
    return {
      status: "configured-caveman-only",
      configPath,
      currentCommand: cmd,
    };
  }
  return { status: "configured-other", configPath, currentCommand: cmd };
}

/**
 * Render a doctor hint for the statusline badge. Returns null when the
 * user either already has the best config (chain) or has a custom
 * statusLine we don't want to touch.
 */
export function formatStatuslineHint(
  result: StatuslineCheckResult,
  ecosystemStatuses: EcosystemToolStatus[],
): string | null {
  const lines: string[] = ["── statusline badge ──"];
  const hasCaveman = ecosystemStatuses.some(
    (s) => s.id === "caveman" && s.status === "installed",
  );
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

  switch (result.status) {
    case "configured-chain":
      // User is already on the best config — stay silent.
      return null;

    case "configured-tp-only":
      if (!hasCaveman) return null;
      lines.push(
        `  ⚠ statusline points at tp-statusline.sh directly but caveman is`,
      );
      lines.push(
        `    installed — switch to statusline-chain.sh so both badges show.`,
      );
      if (pluginRoot) {
        lines.push(
          `    command: bash "${pluginRoot}/hooks/statusline-chain.sh"`,
        );
      }
      return lines.join("\n");

    case "configured-caveman-only":
      // Caveman's own statusline is already live. Suggest swapping to our
      // chain wrapper so the `[TP]` badge joins in side-by-side.
      lines.push(
        `  ⚠ statusline renders caveman's badge only. Switch to token-pilot's`,
      );
      lines.push(
        `    chain wrapper to also show [TP] with enforcement mode + saved tokens.`,
      );
      if (pluginRoot) {
        lines.push(
          `    command: bash "${pluginRoot}/hooks/statusline-chain.sh"`,
        );
      } else {
        lines.push(
          `    command: bash "$(ls -t ~/.claude/plugins/cache/token-pilot/token-pilot/*/hooks/statusline-chain.sh 2>/dev/null | head -1)"`,
        );
      }
      return lines.join("\n");

    case "configured-other":
      // Custom statusLine — respect it, never overwrite.
      return null;

    case "unknown":
      return null;

    case "not-configured": {
      lines.push(
        `  ○ no statusline badge configured — add one to see token-pilot`,
      );
      lines.push(`    state (enforcement mode + cumulative saved tokens) in`);
      lines.push(`    Claude Code's status bar.`);
      lines.push("");
      const command = pluginRoot
        ? `bash "${pluginRoot}/hooks/statusline-chain.sh"`
        : `bash "$(ls -t ~/.claude/plugins/cache/token-pilot/token-pilot/*/hooks/statusline-chain.sh 2>/dev/null | head -1)"`;
      lines.push(`    Add to ${result.configPath}:`);
      lines.push(`      "statusLine": {`);
      lines.push(`        "type": "command",`);
      lines.push(`        "command": "${command.replace(/"/g, '\\"')}"`);
      lines.push(`      }`);
      return lines.join("\n");
    }
  }
}
