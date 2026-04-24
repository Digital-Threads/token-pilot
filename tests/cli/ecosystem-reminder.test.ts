/**
 * Tests for the one-shot ecosystem reminder emitted at MCP startup.
 *
 * Covers the decision predicate (shouldEmitEcosystemReminder) across
 * every suppression channel, and the stateful emitter's single-fire
 * guarantee + stderr side-effect.
 */
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __ECOSYSTEM_REMINDER_MESSAGE,
  __resetEcosystemReminder,
  maybeEmitEcosystemReminder,
  shouldEmitEcosystemReminder,
} from "../../src/cli/ecosystem-reminder.ts";

describe("ecosystem-reminder", () => {
  const originalHome = process.env.HOME;
  const originalUserprofile = process.env.USERPROFILE;
  let fakeHome: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    fakeHome = join(tmpdir(), `tp-ecoremind-${process.pid}-${Date.now()}`);
    await mkdir(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    __resetEcosystemReminder();
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(
        (() => true) as unknown as typeof process.stderr.write,
      );
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserprofile;
    await rm(fakeHome, { recursive: true, force: true });
  });

  // ── Pure predicate ───────────────────────────────────────────────

  it("predicate returns true when caveman is missing and no suppress env", () => {
    expect(shouldEmitEcosystemReminder({ env: {} as NodeJS.ProcessEnv })).toBe(
      true,
    );
  });

  it("predicate respects TOKEN_PILOT_NO_ECOSYSTEM_TIPS=1", () => {
    expect(
      shouldEmitEcosystemReminder({
        env: { TOKEN_PILOT_NO_ECOSYSTEM_TIPS: "1" } as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
  });

  it("predicate silences inside subagents (TOKEN_PILOT_SUBAGENT=1)", () => {
    expect(
      shouldEmitEcosystemReminder({
        env: { TOKEN_PILOT_SUBAGENT: "1" } as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
  });

  it("predicate returns false when caveman IS installed (Claude plugin dir)", async () => {
    const cavemanDir = join(fakeHome, ".claude", "plugins", "cache", "caveman");
    await mkdir(cavemanDir, { recursive: true });

    expect(shouldEmitEcosystemReminder({ env: {} as NodeJS.ProcessEnv })).toBe(
      false,
    );
  });

  // ── Stateful emitter ─────────────────────────────────────────────

  it("emits to stderr the first time caveman is missing", () => {
    const fired = maybeEmitEcosystemReminder({ env: {} as NodeJS.ProcessEnv });
    expect(fired).toBe(true);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0][0]).toBe(__ECOSYSTEM_REMINDER_MESSAGE);
    expect(String(stderrSpy.mock.calls[0][0])).toContain("caveman");
    expect(String(stderrSpy.mock.calls[0][0])).toContain(
      "TOKEN_PILOT_NO_ECOSYSTEM_TIPS",
    );
  });

  it("single-fire — second call is a no-op within the same process", () => {
    expect(maybeEmitEcosystemReminder({ env: {} as NodeJS.ProcessEnv })).toBe(
      true,
    );
    expect(maybeEmitEcosystemReminder({ env: {} as NodeJS.ProcessEnv })).toBe(
      false,
    );
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("never fires when caveman is detected", async () => {
    const cavemanDir = join(fakeHome, ".claude", "plugins", "cache", "caveman");
    await mkdir(cavemanDir, { recursive: true });

    const fired = maybeEmitEcosystemReminder({ env: {} as NodeJS.ProcessEnv });
    expect(fired).toBe(false);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("never fires when silenced via env", () => {
    const fired = maybeEmitEcosystemReminder({
      env: { TOKEN_PILOT_NO_ECOSYSTEM_TIPS: "1" } as NodeJS.ProcessEnv,
    });
    expect(fired).toBe(false);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("message is three stderr lines — bounded footprint", () => {
    const nonEmptyLines = __ECOSYSTEM_REMINDER_MESSAGE
      .split("\n")
      .filter((l) => l.length > 0);
    expect(nonEmptyLines).toHaveLength(3);
  });
});
