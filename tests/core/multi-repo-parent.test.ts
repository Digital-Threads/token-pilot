import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isMultiRepoParent } from "../../src/core/validation";

/**
 * Guard against the cross-project index-bleed bug: when token-pilot is
 * handed a non-git workspace parent that contains several sibling git
 * repos, ast-index would index all of them into one index. The guard
 * detects that shape so the caller can fail safe (disable ast-index +
 * warn) instead of bleeding symbols across projects.
 */
describe("isMultiRepoParent", () => {
  let root: string;

  function repo(name: string, gitAsFile = false) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const git = join(dir, ".git");
    if (gitAsFile) {
      // submodule / worktree style: .git is a file, not a dir
      writeFileSync(git, "gitdir: /elsewhere\n");
    } else {
      mkdirSync(git);
    }
    return dir;
  }

  function plainDir(name: string) {
    mkdirSync(join(root, name), { recursive: true });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tp-mrp-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns true for a non-git dir with >=2 child git repos", () => {
    repo("token-pilot");
    repo("loom-host");
    repo("aimux");
    expect(isMultiRepoParent(root)).toBe(true);
  });

  it("returns false for a dir with exactly one child git repo", () => {
    repo("token-pilot");
    plainDir("docs");
    expect(isMultiRepoParent(root)).toBe(false);
  });

  it("returns false for a dir with no child git repos", () => {
    plainDir("src");
    plainDir("docs");
    expect(isMultiRepoParent(root)).toBe(false);
  });

  it("returns false when the dir itself is a git repo (single project)", () => {
    // root/.git present → root is one project, not a multi-repo parent,
    // even if it nests child repos (submodules).
    mkdirSync(join(root, ".git"));
    repo("vendored-a");
    repo("vendored-b");
    expect(isMultiRepoParent(root)).toBe(false);
  });

  it("counts .git-as-file (submodule/worktree) child repos", () => {
    repo("a", true);
    repo("b", true);
    expect(isMultiRepoParent(root)).toBe(true);
  });

  it("returns false for a non-existent path", () => {
    expect(isMultiRepoParent(join(root, "does-not-exist"))).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isMultiRepoParent("")).toBe(false);
  });
});
