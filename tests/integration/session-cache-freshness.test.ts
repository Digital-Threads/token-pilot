/**
 * A repeated AST query must not be answered from the session cache once the
 * index has changed: past the 15 s refresh window the server refreshes the
 * index first, and an update that changed it drops AST-dependent entries.
 *
 * The real AstIndexClient runs with a fake `exec` standing in for the binary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

const index = vi.hoisted(() => ({
  /** files on disk the index has not seen yet */
  pending: false,
  /** the index knows src/c.ts */
  hasC: false,
}));

vi.mock("../../src/config/loader.js", () => ({
  loadConfig: vi.fn(async () => DEFAULT_CONFIG),
}));

vi.mock("../../src/integration/context-mode-detector.js", () => ({
  detectContextMode: vi.fn(async () => ({ detected: false, source: "none", toolPrefix: "" })),
}));

vi.mock("../../src/git/watcher.js", () => ({
  GitWatcher: class {
    async start(): Promise<void> {}
    onBranchSwitchEvent(): void {}
  },
}));

vi.mock("../../src/git/file-watcher.js", () => ({
  FileWatcher: class {
    start(): void {}
    watchFile(): void {}
    onFileChange(): void {}
    onAstUpdate(): void {}
  },
}));

vi.mock("../../src/ast-index/client.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/ast-index/client.js")>();

  async function fakeExec(args: string[]): Promise<string> {
    switch (args[0]) {
      case "--format":
        return JSON.stringify({ stats: { file_count: 2 } });
      case "update":
        if (!index.pending) return "Index is up to date.";
        index.pending = false;
        index.hasC = true;
        return "Updated: 1 files (1 changed, 0 deleted)";
      case "refs":
        return JSON.stringify({
          definitions: index.hasC
            ? [{ path: "src/c.ts", line: 1, name: "betaCaller", signature: "export function betaCaller() {}" }]
            : [],
          imports: [],
          usages: [],
        });
      case "search":
        return JSON.stringify({ content_matches: [], symbols: [], files: [], references: [] });
      default:
        return "";
    }
  }

  class FakeBinaryClient extends mod.AstIndexClient {
    constructor(...args: ConstructorParameters<typeof mod.AstIndexClient>) {
      super(...args);
      (this as any).binaryPath = "/fake/ast-index";
      (this as any).exec = vi.fn(fakeExec);
    }
    async init(): Promise<void> {}
    startPeriodicUpdate(): void {}
  }

  return { ...mod, AstIndexClient: FakeBinaryClient };
});

describe("session cache and index freshness", () => {
  let root: string;
  let offset = 0;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tp-cache-fresh-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fresh", version: "1.0.0" }));
    index.pending = false;
    index.hasC = false;
    offset = 0;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("a repeated find_usages sees a definition added after the first answer", async () => {
    const { createServer } = await import("../../src/server.js");
    const server = await createServer(root);
    const client = new Client({ name: "fresh-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const ask = async (): Promise<string> => {
      const r = await client.callTool({ name: "find_usages", arguments: { symbol: "betaCaller" } });
      return (r.content as Array<{ text: string }>)[0].text;
    };

    expect(await ask()).not.toContain("src/c.ts");

    await writeFile(join(root, "src", "c.ts"), "export function betaCaller() {}\n");
    index.pending = true;
    offset = 20_000; // past the 15 s refresh window

    expect(await ask()).toContain("src/c.ts");

    await Promise.all([client.close(), server.close()]);
  });
});
