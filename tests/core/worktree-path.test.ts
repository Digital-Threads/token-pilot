/**
 * A linked worktree of the same repository is the same project's code checked
 * out elsewhere. When one sits beside the main checkout (`git worktree add
 * ../feature`), the path hook hands its files over as absolute paths — and the
 * project-root guard used to reject every one of them as "outside project
 * root". Worktrees nested inside the checkout were never affected.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSafePath } from "../../src/core/validation.ts";

let base: string;
let main: string;
let sibling: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "ignore" });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "tp-worktree-"));
  main = join(base, "main");
  sibling = join(base, "main-feature");

  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "t@example.com");
  git(main, "config", "user.name", "t");
  writeFileSync(join(main, "a.ts"), "export const a = 1;\n");
  git(main, "add", "a.ts");
  git(main, "commit", "-qm", "init");
  git(main, "worktree", "add", "-q", sibling, "-b", "feature");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("resolveSafePath — linked worktrees", () => {
  it("allows a path inside a sibling worktree of the same repository", () => {
    const target = join(sibling, "a.ts");

    expect(resolveSafePath(main, target)).toBe(target);
  });

  it("picks up a worktree created after the first lookup", () => {
    // Prime the lookup, then add a worktree mid-session.
    expect(() => resolveSafePath(main, join(base, "later", "a.ts"))).toThrow();
    git(main, "worktree", "add", "-q", join(base, "later"), "-b", "later");

    expect(resolveSafePath(main, join(base, "later", "a.ts"))).toBe(
      join(base, "later", "a.ts"),
    );
  });

  it("does not open the rest of its own checkout to a sub-project root", () => {
    // A session rooted in main/pkg stays confined to main/pkg: its own
    // worktree is not one of the "other" worktrees that get let through.
    mkdirSync(join(main, "pkg"));

    expect(() => resolveSafePath(join(main, "pkg"), join(main, "a.ts"))).toThrow(
      /outside project root/,
    );
  });

  it("still rejects a path outside every worktree", () => {
    expect(() => resolveSafePath(main, join(base, "elsewhere", "a.ts"))).toThrow(
      /outside project root/,
    );
    expect(() => resolveSafePath(main, "../../etc/passwd")).toThrow(
      /outside project root/,
    );
  });
});
