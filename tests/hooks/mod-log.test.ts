/**
 * The Claude Code mod appends its logs through a child process: `$.fs` can
 * only replace a whole file, and read-modify-write loses or wipes lines.
 * These tests run the real argv the mod hands to `$.process.run`.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendArgvs, appendLog } from "../../hooks/mod/host.ts";

function run(argv: string[], stdin: string): void {
  execFileSync(argv[0], argv.slice(1), { input: stdin });
}

describe("mod log append", () => {
  for (const [name, index] of [["sh", 0], ["node", 1]] as const) {
    it(`${name}: creates the directory and appends`, () => {
      const file = join(mkdtempSync(join(tmpdir(), "tp-log-")), "deep", "hook-events.jsonl");

      run(appendArgvs(file, 1000, 1)[index], "a\n");
      run(appendArgvs(file, 1000, 2)[index], "b\n");

      expect(readFileSync(file, "utf8")).toBe("a\nb\n");
    });

    it(`${name}: archives a full log before the append, never over an existing archive`, () => {
      const dir = mkdtempSync(join(tmpdir(), "tp-log-"));
      const file = join(dir, "hook-errors.jsonl");
      writeFileSync(file, "x".repeat(20));
      writeFileSync(join(dir, "hook-errors.7.jsonl"), "kept");

      run(appendArgvs(file, 10, 7)[index], "new\n");

      // the archive name is taken: no rename, the line still lands
      expect(readFileSync(join(dir, "hook-errors.7.jsonl"), "utf8")).toBe("kept");
      expect(readFileSync(file, "utf8")).toBe("x".repeat(20) + "new\n");

      run(appendArgvs(file, 10, 8)[index], "next\n");

      expect(readFileSync(join(dir, "hook-errors.8.jsonl"), "utf8")).toBe("x".repeat(20) + "new\n");
      expect(readFileSync(file, "utf8")).toBe("next\n");
    });
  }

  it("falls back to node when sh is missing", async () => {
    const tried: string[] = [];
    const file = join(mkdtempSync(join(tmpdir(), "tp-log-")), "hook-events.jsonl");

    await appendLog(
      async (argv, init) => {
        tried.push(argv[0]);
        if (argv[0] === "sh") throw new Error("spawn sh ENOENT");
        run(argv, init?.stdin ?? "");
        return { exitCode: 0 };
      },
      file,
      "line",
      1000,
    );

    expect(tried).toEqual(["sh", "node"]);
    expect(readFileSync(file, "utf8")).toBe("line\n");
  });

  it("never touches the file when no appender runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-log-"));
    const file = join(dir, "hook-events.jsonl");
    writeFileSync(file, "old\n");

    await appendLog(async () => ({ exitCode: 127 }), file, "line", 1000);

    expect(readFileSync(file, "utf8")).toBe("old\n");
    expect(readdirSync(dir)).toEqual(["hook-events.jsonl"]);
    expect(existsSync(join(dir, "deep"))).toBe(false);
  });
});
