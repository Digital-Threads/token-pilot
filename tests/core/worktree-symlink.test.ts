/**
 * 1.0.2 audit, item 12 — a worktree beside the project (`../feature`): the
 * path hook rewrote relative paths to absolute ones the server then refused
 * as "outside project root". `git worktree list` prints real paths; a
 * session reaching the same directories through a symlink (a linked home,
 * /tmp → /private/tmp) never matched them.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSafePath } from "../../src/core/validation.ts";

let base: string;
let link: string;
let main: string;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "tp-wt-real-"));
  main = join(base, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "t@example.com");
  git(main, "config", "user.name", "t");
  writeFileSync(join(main, "a.ts"), "export const a = 1;\n");
  git(main, "add", "a.ts");
  git(main, "commit", "-qm", "init");
  git(main, "worktree", "add", "-q", join(base, "feature"), "-b", "feature");

  link = `${base}-link`;
  symlinkSync(base, link);
});

afterEach(() => {
  rmSync(link, { force: true });
  rmSync(base, { recursive: true, force: true });
});

describe("resolveSafePath — a sibling worktree reached through a symlink", () => {
  it("accepts the worktree's file by its symlinked path", () => {
    const target = join(link, "feature", "a.ts");
    expect(resolveSafePath(main, target)).toBe(target);
  });

  it("accepts it when the project root itself is the symlinked path", () => {
    const target = join(base, "feature", "a.ts");
    expect(resolveSafePath(join(link, "main"), target)).toBe(target);
  });

  it("still refuses a path outside every worktree", () => {
    expect(() => resolveSafePath(main, join(link, "elsewhere", "a.ts"))).toThrow(/outside project root/);
  });
});
