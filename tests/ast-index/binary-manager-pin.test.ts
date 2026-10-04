/**
 * Auto-install and the update notice use the ast-index version this
 * token-pilot is tested with, never the newest release: a breaking release
 * (3.56 changed `outline` and the JSON of several commands) must not reach
 * fresh installs before token-pilot supports it.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[][] = [];
const fake = { prefix: "", version: "" };

vi.mock("node:child_process", () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb?: unknown) => {
    const done = (typeof opts === "function" ? opts : cb) as (e: Error | null, out: string, err: string) => void;
    calls.push([cmd, ...args]);

    if (args[0] === "--version") return done(null, `ast-index ${fake.version}\n`, "");
    if (args[0] === "config") return done(null, `${fake.prefix}\n`, "");
    done(null, "", "");
  },
}));

const { TESTED_AST_INDEX_VERSION, checkBinaryUpdate, installBinary } = await import(
  "../../src/ast-index/binary-manager.js"
);

describe("ast-index version pin", () => {
  let binary: string;

  beforeEach(async () => {
    calls.length = 0;
    fake.prefix = await mkdtemp(join(tmpdir(), "tp-pin-"));
    await mkdir(join(fake.prefix, "bin"));
    binary = join(fake.prefix, "bin", "ast-index");
    await writeFile(binary, "");
  });

  it("is 3.56.0", () => {
    expect(TESTED_AST_INDEX_VERSION).toBe("3.56.0");
  });

  it("is the exact version package.json bundles, so the two cannot drift", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"));
    const lock = JSON.parse(readFileSync(join(__dirname, "..", "..", "package-lock.json"), "utf-8"));

    expect(pkg.dependencies["@ast-index/cli"]).toBe(TESTED_AST_INDEX_VERSION);
    expect(lock.packages["node_modules/@ast-index/cli"].version).toBe(TESTED_AST_INDEX_VERSION);
  });

  it("auto-install asks npm for the tested version, not the latest", async () => {
    fake.version = "3.56.0";

    const installed = await installBinary();

    expect(calls).toContainEqual(["npm", "install", "-g", "@ast-index/cli@3.56.0"]);
    expect(installed.version).toBe("3.56.0");
  });

  it("offers an update only up to the tested version and flags a newer one as untested", async () => {
    fake.version = "3.50.0";
    expect(await checkBinaryUpdate(binary)).toEqual({
      current: "3.50.0",
      tested: "3.56.0",
      updateAvailable: true,
      untested: false,
    });

    fake.version = "3.56.0";
    expect(await checkBinaryUpdate(binary)).toMatchObject({ updateAvailable: false, untested: false });

    fake.version = "3.57.0";
    expect(await checkBinaryUpdate(binary)).toMatchObject({ updateAvailable: false, untested: true });
  });
});
