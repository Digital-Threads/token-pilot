import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isPathWithinProject } from "../../src/hooks/path-safety.js";

let projectDir: string;
let outsideDir: string;

beforeEach(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  projectDir = realpathSync(tmpdir()) + `/tp-safety-proj-${stamp}`;
  outsideDir = realpathSync(tmpdir()) + `/tp-safety-outside-${stamp}`;
  await mkdir(projectDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe("isPathWithinProject", () => {
  it("accepts a file directly inside the project root", async () => {
    const file = join(projectDir, "foo.ts");
    await writeFile(file, "x");
    expect(isPathWithinProject(file, projectDir)).toBe(true);
  });

  it("accepts a nested file inside the project", async () => {
    const nested = join(projectDir, "src", "deep", "x.ts");
    await mkdir(join(projectDir, "src", "deep"), { recursive: true });
    await writeFile(nested, "x");
    expect(isPathWithinProject(nested, projectDir)).toBe(true);
  });

  it("rejects a path that traverses out via ..", async () => {
    await writeFile(join(outsideDir, "secret.ts"), "x");
    const traversal = join(
      projectDir,
      "..",
      `tp-safety-outside-${projectDir.split("tp-safety-proj-")[1]}`,
      "secret.ts",
    );
    expect(isPathWithinProject(traversal, projectDir)).toBe(false);
  });

  it("rejects a symlink whose target is outside the project", async () => {
    const target = join(outsideDir, "outside-target.ts");
    await writeFile(target, "secret");
    const link = join(projectDir, "link-to-outside.ts");
    await symlink(target, link);
    expect(isPathWithinProject(link, projectDir)).toBe(false);
  });

  it("accepts a symlink whose target resolves inside the project", async () => {
    const real = join(projectDir, "real.ts");
    await writeFile(real, "ok");
    const link = join(projectDir, "link.ts");
    await symlink(real, link);
    expect(isPathWithinProject(link, projectDir)).toBe(true);
  });

  it("rejects a non-existent file (cannot resolve path)", () => {
    const missing = join(projectDir, "does-not-exist.ts");
    expect(isPathWithinProject(missing, projectDir)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isPathWithinProject("", projectDir)).toBe(false);
  });

  it("accepts the project root itself and rejects a sibling directory with a matching prefix", async () => {
    const sibling = projectDir + "-evil";
    await mkdir(sibling, { recursive: true });
    const evil = join(sibling, "x.ts");
    await writeFile(evil, "x");
    expect(isPathWithinProject(projectDir, projectDir)).toBe(true);
    expect(isPathWithinProject(evil, projectDir)).toBe(false);
    await rm(sibling, { recursive: true, force: true });
  });
});
