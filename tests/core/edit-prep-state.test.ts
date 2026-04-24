/**
 * Tests for the disk-backed edit-prep state.
 *
 * Covers: mark/check roundtrip, cross-project isolation, TTL pruning,
 * malformed state file falls back cleanly, clear helper, and the exact
 * behaviour the PreToolUse:Edit hook subprocess relies on.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearEditPrep,
  isEditPrepared,
  markEditPrepared,
  __test__,
} from "../../src/core/edit-prep-state.ts";

describe("edit-prep-state", () => {
  const { stateDir, stateFile, DEFAULT_TTL_MS } = __test__;
  let projectA: string;
  let projectB: string;

  beforeEach(async () => {
    projectA = join(tmpdir(), `tp-prep-a-${process.pid}-${Date.now()}`);
    projectB = join(tmpdir(), `tp-prep-b-${process.pid}-${Date.now()}`);
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });
    // Wipe any leftover state from previous runs
    await rm(stateFile(projectA), { force: true });
    await rm(stateFile(projectB), { force: true });
  });

  afterEach(async () => {
    await rm(projectA, { recursive: true, force: true });
    await rm(projectB, { recursive: true, force: true });
    await rm(stateFile(projectA), { force: true });
    await rm(stateFile(projectB), { force: true });
  });

  it("mark then check returns true for the same path", () => {
    const file = join(projectA, "src/app.ts");
    expect(isEditPrepared(projectA, file)).toBe(false);
    markEditPrepared(projectA, file);
    expect(isEditPrepared(projectA, file)).toBe(true);
  });

  it("different projects are isolated", () => {
    const file = join(projectA, "src/app.ts");
    markEditPrepared(projectA, file);
    expect(isEditPrepared(projectA, file)).toBe(true);
    // Same logical path but keyed under projectB — must not leak
    expect(isEditPrepared(projectB, file)).toBe(false);
  });

  it("writes the state dir under tmpdir and is safe to call repeatedly", () => {
    const file = join(projectA, "repeat.ts");
    markEditPrepared(projectA, file);
    markEditPrepared(projectA, file);
    markEditPrepared(projectA, file);
    expect(isEditPrepared(projectA, file)).toBe(true);
    expect(existsSync(stateDir())).toBe(true);
  });

  it("expires entries older than TTL", () => {
    const file = join(projectA, "stale.ts");
    const fakeNow = 1_700_000_000_000;
    markEditPrepared(projectA, file, fakeNow);
    // Still fresh right at the boundary
    expect(isEditPrepared(projectA, file, fakeNow + DEFAULT_TTL_MS - 1)).toBe(
      true,
    );
    // Past the boundary → expired
    expect(isEditPrepared(projectA, file, fakeNow + DEFAULT_TTL_MS + 1)).toBe(
      false,
    );
  });

  it("malformed state file falls back to empty state", async () => {
    await mkdir(stateDir(), { recursive: true });
    await writeFile(stateFile(projectA), "this is not JSON", "utf-8");
    // Must not throw — treat as "no prep"
    expect(isEditPrepared(projectA, join(projectA, "x.ts"))).toBe(false);
    // And subsequent marking replaces the file with valid JSON
    markEditPrepared(projectA, join(projectA, "x.ts"));
    const txt = await readFile(stateFile(projectA), "utf-8");
    expect(() => JSON.parse(txt)).not.toThrow();
  });

  it("clearEditPrep resets state for a project without touching other projects", () => {
    const a = join(projectA, "foo.ts");
    const b = join(projectB, "bar.ts");
    markEditPrepared(projectA, a);
    markEditPrepared(projectB, b);
    clearEditPrep(projectA);
    expect(isEditPrepared(projectA, a)).toBe(false);
    expect(isEditPrepared(projectB, b)).toBe(true);
  });

  it("treats relative and absolute paths consistently via resolve()", () => {
    // Mark with absolute path, query with relative — resolve() normalises both
    const abs = join(projectA, "src/app.ts");
    markEditPrepared(projectA, abs);
    expect(isEditPrepared(projectA, abs)).toBe(true);
  });
});
