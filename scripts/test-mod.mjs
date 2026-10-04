// Runs the Claude Code mod's own tests (hooks/mod/*.test.ts).
//
// `claude plugin test` runs every *.test.ts under the folder it is given, so
// the repo's vitest suite in tests/ would be swept in and fail to load. It
// also exits 0 when it finds no hooks module. So: stage the plugin without
// tests/, validate it, run it, and require a real pass count.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const stage = mkdtempSync(join(tmpdir(), "tp-mod-"));
try {
  for (const dir of [".claude-plugin", "hooks", "src"]) {
    cpSync(dir, join(stage, dir), { recursive: true });
  }

  for (const args of [
    ["plugin", "validate", stage],
    ["plugin", "test", stage],
  ]) {
    const run = spawnSync("claude", args, { encoding: "utf8" });
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    process.stdout.write(out);

    if (run.status !== 0) process.exit(1);
    if (args[1] === "test" && Number(/(\d+) pass/.exec(out)?.[1] ?? 0) === 0) {
      process.exit(1);
    }
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
