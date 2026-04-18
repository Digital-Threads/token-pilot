/**
 * TP-c08 — doctor check for Claude Code env knobs that give large
 * session savings with zero code change. Community guide item B1.
 *
 * Pure function `checkClaudeCodeEnv(opts)` takes an env snapshot and
 * the contents of `~/.claude/settings.json` and returns a list of
 * human-readable tips. Each tip corresponds to one missing / low-value
 * knob. Empty array means "all good".
 */
import { describe, it, expect } from "vitest";
import { checkClaudeCodeEnv } from "../../src/cli/doctor-env-check.js";

describe("checkClaudeCodeEnv", () => {
  it("returns no tips when all four knobs are set well", () => {
    const tips = checkClaudeCodeEnv({
      env: {
        CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
        MAX_THINKING_TOKENS: "10000",
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50",
      },
      settings: { model: "sonnet", env: {} },
    });
    expect(tips).toEqual([]);
  });

  it("reads settings.env.* as a fallback when process env is empty", () => {
    const tips = checkClaudeCodeEnv({
      env: {},
      settings: {
        model: "sonnet",
        env: {
          CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
          MAX_THINKING_TOKENS: "10000",
          CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50",
        },
      },
    });
    expect(tips).toEqual([]);
  });

  it("suggests CLAUDE_CODE_SUBAGENT_MODEL=haiku when unset", () => {
    const tips = checkClaudeCodeEnv({
      env: {
        MAX_THINKING_TOKENS: "10000",
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50",
      },
      settings: { model: "sonnet" },
    });
    expect(tips.some((t) => /CLAUDE_CODE_SUBAGENT_MODEL/.test(t))).toBe(true);
    expect(tips.some((t) => /haiku/.test(t))).toBe(true);
  });

  it("suggests MAX_THINKING_TOKENS when absent or above 32000", () => {
    const absent = checkClaudeCodeEnv({
      env: {
        CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50",
      },
      settings: { model: "sonnet" },
    });
    expect(absent.some((t) => /MAX_THINKING_TOKENS/.test(t))).toBe(true);

    const high = checkClaudeCodeEnv({
      env: {
        CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
        MAX_THINKING_TOKENS: "32000",
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50",
      },
      settings: { model: "sonnet" },
    });
    expect(high.some((t) => /MAX_THINKING_TOKENS/.test(t))).toBe(true);
  });

  it("suggests CLAUDE_AUTOCOMPACT_PCT_OVERRIDE when absent or above 80", () => {
    const absent = checkClaudeCodeEnv({
      env: {
        CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
        MAX_THINKING_TOKENS: "10000",
      },
      settings: { model: "sonnet" },
    });
    expect(absent.some((t) => /CLAUDE_AUTOCOMPACT_PCT_OVERRIDE/.test(t))).toBe(
      true,
    );
  });

  it("suggests model:sonnet when settings.model is opus", () => {
    const tips = checkClaudeCodeEnv({
      env: {
        CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
        MAX_THINKING_TOKENS: "10000",
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50",
      },
      settings: { model: "opus" },
    });
    expect(tips.some((t) => /model.*sonnet/i.test(t))).toBe(true);
  });

  it("does not complain when settings.model is missing (Claude Code default ok)", () => {
    const tips = checkClaudeCodeEnv({
      env: {
        CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
        MAX_THINKING_TOKENS: "10000",
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50",
      },
      settings: {},
    });
    expect(tips).toEqual([]);
  });

  it("handles null / invalid settings without throwing", () => {
    expect(() =>
      checkClaudeCodeEnv({ env: {}, settings: null as any }),
    ).not.toThrow();
    expect(() =>
      checkClaudeCodeEnv({ env: {}, settings: "not an object" as any }),
    ).not.toThrow();
  });

  it("gives all four tips when nothing is configured", () => {
    const tips = checkClaudeCodeEnv({ env: {}, settings: {} });
    expect(tips).toHaveLength(3); // model only flags when explicitly set to opus
    const joined = tips.join("\n");
    expect(joined).toMatch(/CLAUDE_CODE_SUBAGENT_MODEL/);
    expect(joined).toMatch(/MAX_THINKING_TOKENS/);
    expect(joined).toMatch(/CLAUDE_AUTOCOMPACT_PCT_OVERRIDE/);
  });
});
