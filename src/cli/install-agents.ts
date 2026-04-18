/**
 * Phase 5 subtasks 5.3 + 5.4 — install tp-* agents into the user's
 * Claude Code agent registry.
 *
 * Copies every `tp-*.md` from `distAgentsDir` into either
 * `<projectRoot>/.claude/agents/` (scope=project) or
 * `<homeDir>/.claude/agents/` (scope=user).
 *
 * Idempotence states (see Phase 5 design):
 *
 *  - **unchanged-installed** — stored hash matches template hash → skip
 *    (re-write would be a no-op).
 *  - **template-upgraded** — stored hash differs from template hash AND
 *    the file body still matches the stored hash (user did not edit) →
 *    overwrite.
 *  - **user-edited** — stored hash does not match the file body hash →
 *    skip unless `force: true`.
 *  - **no-hash** — file has no `token_pilot_body_hash` in frontmatter
 *    → never overwrite. This is always treated as the user's own file,
 *    even when `force: true`.
 *
 * Never throws on a per-file failure: the problem is recorded in
 * `skipped` so the CLI can report it without aborting the rest.
 */

import { readdir, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./agent-frontmatter.js";

export type Scope = "user" | "project";

export interface InstallOptions {
  scope: Scope;
  /** Used when scope === "project". */
  projectRoot: string;
  /** Used when scope === "user". */
  homeDir: string;
  /** Directory holding the rendered dist/agents/tp-*.md files. */
  distAgentsDir: string;
  /** When true, overwrite user-edited files (never no-hash files). */
  force?: boolean;
}

export interface InstallResult {
  /** Names of files actually written during this run. */
  installed: string[];
  /** Entries that were deliberately left alone; reason explains why. */
  skipped: Array<{ name: string; reason: string }>;
  /** Absolute path we wrote (or would have written) into. */
  targetDir: string;
}

function targetDirFor(opts: InstallOptions): string {
  const root = opts.scope === "user" ? opts.homeDir : opts.projectRoot;
  return join(root, ".claude", "agents");
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Extract the body portion (everything after the closing `---\n`). */
function extractBody(md: string): string {
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : md;
}

/**
 * Read a tp-*.md from disk and return the stored `token_pilot_body_hash`
 * from frontmatter. Returns `null` when the field is absent — this
 * marks the file as user-owned (no-hash state).
 */
async function readStoredHash(p: string): Promise<string | null> {
  try {
    const md = await readFile(p, "utf-8");
    const { meta } = parseFrontmatter(md);
    const stored = meta.token_pilot_body_hash;
    return typeof stored === "string" && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

export async function installAgents(
  opts: InstallOptions,
): Promise<InstallResult> {
  const target = targetDirFor(opts);
  const result: InstallResult = {
    installed: [],
    skipped: [],
    targetDir: target,
  };

  let entries: string[];
  try {
    entries = await readdir(opts.distAgentsDir);
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).code ?? String(err);
    throw new Error(
      `install-agents: distAgentsDir not readable (${opts.distAgentsDir}): ${msg}`,
    );
  }

  const templates = entries.filter(
    (f) => f.endsWith(".md") && f.startsWith("tp-"),
  );
  if (templates.length === 0) {
    return result;
  }

  await mkdir(target, { recursive: true });

  for (const entry of templates) {
    const name = entry.replace(/\.md$/, "");
    const distPath = join(opts.distAgentsDir, entry);
    const targetPath = join(target, entry);

    let templateMd: string;
    try {
      templateMd = await readFile(distPath, "utf-8");
    } catch {
      result.skipped.push({ name, reason: "dist read failed" });
      continue;
    }
    const templateHash = sha256(extractBody(templateMd));

    if (!(await pathExists(targetPath))) {
      // Fresh install.
      try {
        await writeFile(targetPath, templateMd);
        result.installed.push(name);
      } catch {
        result.skipped.push({ name, reason: "write failed" });
      }
      continue;
    }

    // Target exists — classify state.
    const existing = await readFile(targetPath, "utf-8");
    const storedHash = await readStoredHash(targetPath);
    const currentBodyHash = sha256(extractBody(existing));

    if (storedHash === null) {
      // no-hash: user's own file. Never touch, even with --force.
      result.skipped.push({
        name,
        reason: "not installed by token-pilot (no token_pilot_body_hash)",
      });
      continue;
    }

    // user-edited must be detected BEFORE the unchanged check, because a
    // user may hand-edit an agent whose stored hash still equals the
    // current template hash (common: local tweak, no template update).
    if (currentBodyHash !== storedHash) {
      if (opts.force) {
        try {
          await writeFile(targetPath, templateMd);
          result.installed.push(name);
        } catch {
          result.skipped.push({ name, reason: "write failed" });
        }
      } else {
        result.skipped.push({
          name,
          reason: "edited by user (use --force to override)",
        });
      }
      continue;
    }

    if (storedHash === templateHash) {
      // unchanged-installed: silent skip (re-write would be a no-op).
      result.skipped.push({ name, reason: "unchanged" });
      continue;
    }

    // template-upgraded: user did not edit (currentBodyHash === storedHash)
    // but the template has moved on — safe to overwrite.
    try {
      await writeFile(targetPath, templateMd);
      result.installed.push(name);
    } catch {
      result.skipped.push({ name, reason: "write failed" });
    }
  }

  return result;
}

// ─── CLI wrapper ─────────────────────────────────────────────────────────────

/**
 * Resolve the dist/agents directory relative to the running `dist/index.js`
 * entry. Works for both `npm run start` (dist/) and `npm pack`-installed
 * users (node_modules/token-pilot/dist/agents/). Falls back to `templates/
 * agents` only when we are clearly running from source (tests, dev mode).
 */
export function resolveDistAgentsDir(scriptUrl: string): string {
  // Compiled layout: dist/cli/install-agents.js → dist/agents/.
  // One level up from our own file, then into agents/.
  const here = dirname(fileURLToPath(scriptUrl));
  return join(here, "..", "agents");
}

/** Read one line from an interactive TTY prompt. */
async function promptLine(question: string): Promise<string> {
  process.stderr.write(question);
  return new Promise<string>((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question("", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptScope(): Promise<Scope> {
  process.stderr.write(
    "\nWhere should token-pilot agents be installed?\n" +
      "  [1] user     → ~/.claude/agents/tp-*.md (available in every project)\n" +
      "  [2] project  → .claude/agents/tp-*.md (only this project)\n",
  );
  while (true) {
    const ans = (await promptLine("Choice [1/2]: ")).toLowerCase();
    if (ans === "1" || ans === "user") return "user";
    if (ans === "2" || ans === "project") return "project";
    process.stderr.write("Please enter 1 or 2.\n");
  }
}

function parseFlag(argv: string[], key: string): string | undefined {
  for (const a of argv) {
    if (a === `--${key}` || a === `-${key}`) return "true";
    if (a.startsWith(`--${key}=`)) return a.slice(key.length + 3);
  }
  return undefined;
}

// ─── scope persistence in .token-pilot.json ─────────────────────────────────

function configPath(projectRoot: string): string {
  return join(projectRoot, ".token-pilot.json");
}

/**
 * Read `agents.scope` from `<projectRoot>/.token-pilot.json`. Returns
 * null if the file is missing, unreadable, not valid JSON, or if the
 * field is absent. Never throws — a bad config should not block install.
 */
export async function readPersistedScope(
  projectRoot: string,
): Promise<Scope | null> {
  try {
    const raw = await readFile(configPath(projectRoot), "utf-8");
    const json = JSON.parse(raw) as { agents?: { scope?: unknown } };
    const s = json.agents?.scope;
    if (s === "user" || s === "project") return s;
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist `agents.scope` into `<projectRoot>/.token-pilot.json`, merging
 * with any existing config. Failures are swallowed — persistence is a
 * convenience, not a correctness requirement.
 */
export async function persistScope(
  projectRoot: string,
  scope: Scope,
): Promise<void> {
  const p = configPath(projectRoot);
  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    /* fresh file */
  }
  const currentAgents =
    (existing.agents as Record<string, unknown> | undefined) ?? {};
  const next = {
    ...existing,
    agents: { ...currentAgents, scope },
  };
  try {
    await writeFile(p, JSON.stringify(next, null, 2) + "\n");
  } catch {
    /* ignore — persistence is best-effort */
  }
}

/**
 * CLI entry: `token-pilot install-agents [--scope=user|project] [--force]`.
 *
 * Exit codes:
 *   0 — something installed OR everything was deliberately skipped
 *   1 — missing/unreadable dist/agents, or non-TTY without --scope
 */
export async function handleInstallAgents(
  argv: string[],
  opts?: {
    distAgentsDir?: string;
    homeDir?: string;
    projectRoot?: string;
    isTTY?: boolean;
  },
): Promise<number> {
  const scopeArg = parseFlag(argv, "scope");
  const force = parseFlag(argv, "force") !== undefined;
  const projectRoot = opts?.projectRoot ?? process.cwd();

  let scope: Scope;
  if (scopeArg === "user" || scopeArg === "project") {
    scope = scopeArg;
  } else if (scopeArg !== undefined) {
    process.stderr.write(
      `install-agents: --scope must be 'user' or 'project', got '${scopeArg}'\n`,
    );
    return 1;
  } else {
    // No flag — try persisted scope from .token-pilot.json, else prompt.
    const persisted = await readPersistedScope(projectRoot);
    if (persisted) {
      scope = persisted;
      process.stderr.write(
        `[token-pilot] Using persisted scope: ${scope} (from .token-pilot.json)\n`,
      );
    } else {
      const tty = opts?.isTTY ?? process.stdin.isTTY === true;
      if (!tty) {
        process.stderr.write(
          "install-agents: --scope=user|project is required in non-interactive mode.\n",
        );
        return 1;
      }
      scope = await promptScope();
    }
  }

  const distAgentsDir =
    opts?.distAgentsDir ?? resolveDistAgentsDir(import.meta.url);

  try {
    const result = await installAgents({
      scope,
      projectRoot,
      homeDir: opts?.homeDir ?? homedir(),
      distAgentsDir,
      force,
    });

    const plural = (n: number, s: string) => (n === 1 ? s : s + "s");
    if (result.installed.length > 0) {
      // Best-effort persist the chosen scope so re-runs skip the prompt.
      await persistScope(projectRoot, scope);
      process.stderr.write(
        `\n[token-pilot] Installed ${result.installed.length} ${plural(result.installed.length, "agent")} ` +
          `to ${result.targetDir}.\n` +
          `Start a new Claude Code session to see them.\n`,
      );
    }
    if (result.skipped.length > 0) {
      process.stderr.write(`[token-pilot] Skipped ${result.skipped.length}:\n`);
      for (const s of result.skipped) {
        process.stderr.write(`  - ${s.name}: ${s.reason}\n`);
      }
    }
    if (result.installed.length === 0 && result.skipped.length === 0) {
      process.stderr.write(
        `[token-pilot] No tp-*.md found in ${distAgentsDir}. ` +
          `Did you run \`npm run build\`?\n`,
      );
      return 1;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`install-agents: ${(err as Error).message}\n`);
    return 1;
  }
}

// ─── Startup reminder (Phase 5 subtask 5.6) ─────────────────────────────────

export interface StartupReminderOptions {
  projectRoot: string;
  homeDir: string;
  /**
   * If true, the reminder is suppressed. Callers pass
   * `cfg.agents.reminder === false` here.
   */
  configSuppressed: boolean;
  /** Environment snapshot to consult; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Scan both user-scope (`<homeDir>/.claude/agents`) and project-scope
 * (`<projectRoot>/.claude/agents`) for any `tp-*.md`. The reminder fires
 * only when nothing is found in either location.
 */
async function anyTpAgentInstalled(
  projectRoot: string,
  homeDir: string,
): Promise<boolean> {
  for (const root of [projectRoot, homeDir]) {
    try {
      const entries = await readdir(join(root, ".claude", "agents"));
      if (entries.some((f) => f.startsWith("tp-") && f.endsWith(".md"))) {
        return true;
      }
    } catch {
      // Missing dir → this scope has nothing; keep checking.
    }
  }
  return false;
}

/**
 * Pure, testable check: should the MCP startup emit the agent-install
 * reminder right now?
 */
export async function shouldEmitStartupReminder(
  opts: StartupReminderOptions,
): Promise<boolean> {
  const env = opts.env ?? process.env;
  if (env.TOKEN_PILOT_NO_AGENT_REMINDER === "1") return false;
  if (env.TOKEN_PILOT_SUBAGENT === "1") return false;
  if (opts.configSuppressed) return false;
  return !(await anyTpAgentInstalled(opts.projectRoot, opts.homeDir));
}

export const STARTUP_REMINDER_MESSAGE =
  "[token-pilot] tp-* agents not installed. Run `npx token-pilot install-agents` " +
  "to enable guaranteed-savings subagents (scope: user or project — your choice).\n";

/**
 * Emit the reminder to stderr at most once per process. Safe to call
 * multiple times; subsequent calls are no-ops.
 */
let startupReminderEmitted = false;

export async function maybeEmitStartupReminder(
  opts: StartupReminderOptions,
): Promise<boolean> {
  if (startupReminderEmitted) return false;
  if (!(await shouldEmitStartupReminder(opts))) return false;
  process.stderr.write(STARTUP_REMINDER_MESSAGE);
  startupReminderEmitted = true;
  return true;
}

/** Test-only: reset the single-fire guard. */
export function _resetStartupReminderForTests(): void {
  startupReminderEmitted = false;
}
