import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AstIndexClient } from "../../src/ast-index/client.js";

describe("AstIndexClient.fileImports", () => {
  it("reads JS/TS imports from the file — the binary loses multi-line import sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "tp-imports-"));
    await writeFile(join(root, "a.ts"), "import {\n  b,\n} from './b.js';\n");

    const client = new AstIndexClient(root) as any;
    client.binaryPath = "/bin/ast-index";
    client.ensureIndex = async () => {};
    client.exec = vi.fn(async () => "Imports in a.ts:\n  {\n\n  Total: 1 imports\n");

    expect(await client.fileImports(join(root, "a.ts"))).toEqual([
      { specifiers: ["b"], source: "./b.js" },
    ]);
    expect(await client.fileImports("a.ts")).toEqual([
      { specifiers: ["b"], source: "./b.js" },
    ]);
    expect(client.exec).not.toHaveBeenCalled();

    await rm(root, { recursive: true, force: true });
  });
});
