/**
 * TP-rtg — `.claudeignore` generator + CLAUDE.md hygiene helpers.
 *
 * Two small modules, tested together:
 *  - claudeignore: status() + writeDefaults() — non-destructive,
 *    identifies our managed file by a magic comment.
 *  - claudemd-hygiene: lineCount() + assessment() — read-only measure
 *    of CLAUDE.md size with a configurable threshold.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeIgnoreStatus,
  writeDefaultClaudeIgnore,
  CLAUDEIGNORE_MANAGED_MARKER,
  DEFAULT_IGNORE_ENTRIES,
} from "../../src/cli/claudeignore.js";
import {
  assessClaudeMd,
  CLAUDE_MD_LINE_THRESHOLD,
} from "../../src/cli/claudemd-hygiene.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tp-ignore-test-"));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

// ─── claudeIgnoreStatus ──────────────────────────────────────────────────────

describe("claudeIgnoreStatus", () => {
  it("returns 'absent' when the file does not exist", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const s = await claudeIgnoreStatus(dir);
    expect(s.kind).toBe("absent");
  });

  it("returns 'managed' when the file contains our magic marker", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    await writeFile(
      join(dir, ".claudeignore"),
      `${CLAUDEIGNORE_MANAGED_MARKER}\nnode_modules/\ndist/\n`,
    );
    const s = await claudeIgnoreStatus(dir);
    expect(s.kind).toBe("managed");
  });

  it("returns 'user-owned' when the file exists without our marker", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    await writeFile(join(dir, ".claudeignore"), "custom/\nmy-secret.txt\n");
    const s = await claudeIgnoreStatus(dir);
    expect(s.kind).toBe("user-owned");
  });
});

// ─── writeDefaultClaudeIgnore ────────────────────────────────────────────────

describe("writeDefaultClaudeIgnore", () => {
  it("writes the default set with the managed marker on a fresh project", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const wrote = await writeDefaultClaudeIgnore(dir);
    expect(wrote).toBe(true);
    expect(await fileExists(join(dir, ".claudeignore"))).toBe(true);

    const content = await readFile(join(dir, ".claudeignore"), "utf-8");
    expect(content).toContain(CLAUDEIGNORE_MANAGED_MARKER);
    for (const entry of DEFAULT_IGNORE_ENTRIES) {
      expect(content).toContain(entry);
    }
  });

  it("refuses to overwrite a user-owned file (no marker)", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const existing = "my-custom-ignore/\n";
    await writeFile(join(dir, ".claudeignore"), existing);

    const wrote = await writeDefaultClaudeIgnore(dir);
    expect(wrote).toBe(false);
    const after = await readFile(join(dir, ".claudeignore"), "utf-8");
    expect(after).toBe(existing);
  });

  it("refreshes a managed file in place (same marker detected)", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    await writeFile(
      join(dir, ".claudeignore"),
      `${CLAUDEIGNORE_MANAGED_MARKER}\nold-entry/\n`,
    );
    const wrote = await writeDefaultClaudeIgnore(dir);
    expect(wrote).toBe(true);
    const content = await readFile(join(dir, ".claudeignore"), "utf-8");
    expect(content).not.toContain("old-entry");
    for (const entry of DEFAULT_IGNORE_ENTRIES) {
      expect(content).toContain(entry);
    }
  });
});

// ─── assessClaudeMd ──────────────────────────────────────────────────────────

describe("assessClaudeMd", () => {
  it("returns 'missing' when CLAUDE.md is not present", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const r = await assessClaudeMd(dir);
    expect(r.kind).toBe("missing");
  });

  it("returns 'ok' when the file is under the threshold", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    await writeFile(
      join(dir, "CLAUDE.md"),
      "# My rules\n\nShort file.\n- rule 1\n- rule 2\n",
    );
    const r = await assessClaudeMd(dir);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok")
      expect(r.nonEmptyLines).toBeLessThan(CLAUDE_MD_LINE_THRESHOLD);
  });

  it("returns 'bloated' when CLAUDE.md exceeds the line threshold", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const lines = [];
    for (let i = 0; i < 80; i++) lines.push(`- item ${i}`);
    await writeFile(join(dir, "CLAUDE.md"), lines.join("\n") + "\n");
    const r = await assessClaudeMd(dir);
    expect(r.kind).toBe("bloated");
    if (r.kind === "bloated") {
      expect(r.nonEmptyLines).toBe(80);
      expect(r.threshold).toBe(CLAUDE_MD_LINE_THRESHOLD);
    }
  });

  it("ignores empty lines and horizontal rules when counting", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const body = [
      "# heading",
      "",
      "---",
      "",
      "rule one",
      "",
      "rule two",
      "",
    ].join("\n");
    await writeFile(join(dir, "CLAUDE.md"), body);
    const r = await assessClaudeMd(dir);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.nonEmptyLines).toBe(3); // heading + 2 rules
  });

  it("constant threshold is 60 lines per TP-816 / community guide B3", () => {
    expect(CLAUDE_MD_LINE_THRESHOLD).toBe(60);
  });
});
