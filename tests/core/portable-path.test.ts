/**
 * The Claude Code mod has no node:path, and Claude Code also runs on
 * Windows. These helpers stand in for node:path in code the mod imports.
 */
import { describe, it, expect } from "vitest";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  toSlash,
} from "../../src/core/portable-path.ts";

describe("portable-path", () => {
  it("treats POSIX and Windows roots as absolute", () => {
    expect(isAbsolute("/repo/a.ts")).toBe(true);
    expect(isAbsolute("C:\\repo\\a.ts")).toBe(true);
    expect(isAbsolute("c:/repo")).toBe(true);
    expect(isAbsolute("src/a.ts")).toBe(false);
    expect(isAbsolute("C:relative")).toBe(false);
  });

  it("resolves like node:path on POSIX", () => {
    expect(resolve("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
    expect(resolve("/repo/wt", "../x/./y.ts")).toBe("/repo/x/y.ts");
    expect(resolve("/repo", "/abs/b.ts")).toBe("/abs/b.ts");
    expect(resolve("/repo", "")).toBe("/repo");
  });

  it("resolves Windows paths to forward slashes", () => {
    expect(resolve("C:\\repo\\wt", "src\\a.ts")).toBe("C:/repo/wt/src/a.ts");
  });

  it("computes relative paths", () => {
    expect(relative("/repo", "/repo/packages/api")).toBe("packages/api");
    expect(relative("/repo", "/repo")).toBe("");
    expect(relative("/repo/a", "/repo/b/c")).toBe("../b/c");
    expect(relative("C:\\repo", "C:\\repo\\pkg")).toBe("pkg");
  });

  it("dirname, join, toSlash", () => {
    expect(dirname("/repo/src/a.ts")).toBe("/repo/src");
    expect(dirname("/a")).toBe("/");
    expect(join("/repo", "agents", "tp-run.md")).toBe("/repo/agents/tp-run.md");
    expect(toSlash("C:\\a\\b")).toBe("C:/a/b");
  });
});

describe("portable-path — Windows details", () => {
  it("keeps a UNC share's leading double slash", () => {
    expect(normalize("\\\\server\\share\\a\\..\\b")).toBe("//server/share/b");
    expect(isAbsolute("\\\\server\\share")).toBe(true);
    expect(resolve("//server/share/repo", "src/a.ts")).toBe("//server/share/repo/src/a.ts");
    expect(dirname("//server/share/a")).toBe("//server/share/");
  });

  it("never walks above a UNC share", () => {
    expect(dirname("//server/share/")).toBe("//server/share/");
    expect(normalize("//server/share/..")).toBe("//server/share/");
  });

  it("joins onto the root without making a share of it", () => {
    expect(resolve("/", "a/b")).toBe("/a/b");
    expect(join("/", "a", "b")).toBe("/a/b");
    expect(join("/", "/a/b")).toBe("/a/b");
    expect(join("C:/", "a")).toBe("C:/a");
    expect(join("//server/share/", "a")).toBe("//server/share/a");
  });

  it("reads a lone leading double slash as POSIX root, not a share", () => {
    expect(normalize("//foo")).toBe("/foo");
    expect(relative("//Repo", "//repo")).toBe("../repo");
  });

  it("compares Windows paths case-insensitively, POSIX paths exactly", () => {
    expect(relative("C:/Repo", "c:/repo/src")).toBe("src");
    expect(relative("//Server/Share", "//server/share/x")).toBe("x");
    expect(relative("/Repo", "/repo/src")).toBe("../repo/src");
  });
});
