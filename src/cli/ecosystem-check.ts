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

import { existsSync } from "node:fs";
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
