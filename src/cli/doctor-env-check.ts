/**
 * TP-c08 — detect Claude Code environment knobs that the community
 * usage-limit guide (TP-yk9) calls out as giving 60-80% session savings
 * with zero code change.
 *
 * This is pure advisory: we never modify the user's environment or
 * settings file. `checkClaudeCodeEnv` returns a list of one-line tips,
 * each pointing at a missing or wasteful knob. Empty list == all good.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_THINKING_TOKENS_CAP = 16000;
const MAX_AUTOCOMPACT_PCT = 80;

export interface EnvCheckInput {
  /** Snapshot of process.env (pass in for testability). */
  env: Record<string, string | undefined>;
  /**
   * Parsed contents of `~/.claude/settings.json`. Pass `null` / anything
   * non-object to represent "file missing or unreadable".
   */
  settings: unknown;
}

function asRecord(x: unknown): Record<string, unknown> {
  if (x && typeof x === "object" && !Array.isArray(x)) {
    return x as Record<string, unknown>;
  }
  return {};
}

/**
 * Pull the effective value of a Claude Code env knob. Process env wins
 * over `settings.env.*` because if Claude Code or the user's shell
 * exported a value, that is what the child process actually sees.
 */
function effective(
  envKey: string,
  processEnv: Record<string, string | undefined>,
  settingsEnv: Record<string, unknown>,
): string | undefined {
  if (typeof processEnv[envKey] === "string" && processEnv[envKey] !== "") {
    return processEnv[envKey];
  }
  const fromSettings = settingsEnv[envKey];
  if (typeof fromSettings === "string" && fromSettings !== "") {
    return fromSettings;
  }
  return undefined;
}

export function checkClaudeCodeEnv(input: EnvCheckInput): string[] {
  const tips: string[] = [];
  const settings = asRecord(input.settings);
  const settingsEnv = asRecord(settings.env);

  // CLAUDE_CODE_SUBAGENT_MODEL=haiku — biggest single knob for subagent
  // savings (~80% cheaper than Sonnet for the exploration work delegates
  // do). Unset → cost stays at default.
  const subagentModel = effective(
    "CLAUDE_CODE_SUBAGENT_MODEL",
    input.env,
    settingsEnv,
  );
  if (!subagentModel || subagentModel === "opus") {
    tips.push(
      `CLAUDE_CODE_SUBAGENT_MODEL not set to haiku — add \`"CLAUDE_CODE_SUBAGENT_MODEL": "haiku"\` under \`env\` in ~/.claude/settings.json to route subagents to Haiku (~80% cheaper).`,
    );
  }

  // MAX_THINKING_TOKENS — Claude's hidden reasoning tokens default to
  // 32000. Community finds 10000 saves ~70% with minimal quality loss.
  const thinking = effective("MAX_THINKING_TOKENS", input.env, settingsEnv);
  const thinkingNum = thinking ? Number.parseInt(thinking, 10) : null;
  if (
    !thinking ||
    thinkingNum === null ||
    !Number.isFinite(thinkingNum) ||
    thinkingNum > MAX_THINKING_TOKENS_CAP
  ) {
    tips.push(
      `MAX_THINKING_TOKENS ${thinking ? `is ${thinking}` : "unset (defaults to 32000)"} — add \`"MAX_THINKING_TOKENS": "10000"\` under \`env\` in ~/.claude/settings.json to cap hidden reasoning tokens (~70% saving).`,
    );
  }

  // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE — compact at 50% instead of the
  // default 95%. Keeps sessions healthier, fewer token cliffs.
  const autocompact = effective(
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
    input.env,
    settingsEnv,
  );
  const autoNum = autocompact ? Number.parseInt(autocompact, 10) : null;
  if (
    !autocompact ||
    autoNum === null ||
    !Number.isFinite(autoNum) ||
    autoNum > MAX_AUTOCOMPACT_PCT
  ) {
    tips.push(
      `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ${autocompact ? `is ${autocompact}` : "unset"} — add \`"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50"\` under \`env\` in ~/.claude/settings.json to compact context earlier (healthier sessions).`,
    );
  }

  // settings.model — only flag if explicitly set to opus. Absence means
  // Claude Code's own default, which may be the right choice for the
  // user; we don't second-guess.
  const model = settings.model;
  if (typeof model === "string" && model === "opus") {
    tips.push(
      `"model": "opus" in ~/.claude/settings.json defaults every session to Opus (~5× Sonnet cost). Set \`"model": "sonnet"\` if you don't actively need Opus reasoning on every task.`,
    );
  }

  return tips;
}

/**
 * Load `~/.claude/settings.json` and run the pure check. Silent on I/O
 * failures — a missing file simply means "no settings, all tips apply".
 */
export async function runClaudeCodeEnvCheck(
  homeDirPath: string = homedir(),
  processEnv: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  let settings: unknown = {};
  try {
    const raw = await readFile(
      join(homeDirPath, ".claude", "settings.json"),
      "utf-8",
    );
    settings = JSON.parse(raw);
  } catch {
    // Missing or malformed — treat as empty settings. Tips will surface.
  }
  return checkClaudeCodeEnv({ env: processEnv, settings });
}
