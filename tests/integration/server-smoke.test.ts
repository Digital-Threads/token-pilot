import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

const mockState = vi.hoisted(() => ({
  root: "",
}));

vi.mock("../../src/config/loader.js", () => ({
  loadConfig: vi.fn(async () => DEFAULT_CONFIG),
}));

vi.mock("../../src/integration/context-mode-detector.js", () => ({
  detectContextMode: vi.fn(async () => ({
    detected: false,
    source: "none",
    toolPrefix: "",
  })),
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

vi.mock("../../src/ast-index/client.js", () => ({
  AstIndexClient: class {
    constructor(private readonly projectRoot: string) {}
    async init(): Promise<void> {}
    async ensureIndex(): Promise<void> {}
    isDisabled(): boolean {
      return false;
    }
    isOversized(): boolean {
      return false;
    }
    isAvailable(): boolean {
      return true;
    }
    disableIndex(): void {}
    enableIndex(): void {}
    updateProjectRoot(): void {}
    async incrementalUpdate(): Promise<void> {}
    startPeriodicUpdate(): void {}
    stopPeriodicUpdate(): void {}
    async outline(filePath: string): Promise<any> {
      if (!filePath.endsWith("app.ts")) return null;
      return {
        path: filePath,
        language: "TypeScript",
        meta: {
          lines: 240,
          bytes: 10_000,
          lastModified: Date.now(),
          contentHash: "hash",
        },
        imports: [],
        exports: [],
        symbols: [
          {
            name: "app",
            qualifiedName: "app",
            kind: "function",
            signature: "export function app()",
            location: { startLine: 1, endLine: 20, lineCount: 20 },
            visibility: "public",
            async: false,
            static: false,
            decorators: [],
            children: [],
            doc: null,
            references: [],
          },
        ],
      };
    }
    async refs(symbol: string): Promise<any> {
      if (symbol !== "app") {
        return { definitions: [], imports: [], usages: [] };
      }
      return {
        definitions: [
          {
            path: join(mockState.root, "app.ts"),
            line: 1,
            name: "app",
            signature: "export function app()",
          },
        ],
        imports: [
          {
            path: join(mockState.root, "consumer.ts"),
            line: 1,
            name: "app",
            context: 'import { app } from "./app"',
          },
        ],
        usages: [
          {
            path: join(mockState.root, "consumer.ts"),
            line: 3,
            name: "app",
            context: "app();",
          },
        ],
      };
    }
    async search(): Promise<any[]> {
      return [];
    }
    async map(): Promise<any> {
      return null;
    }
    async conventions(): Promise<any> {
      return null;
    }
    async stats(): Promise<string | null> {
      return null;
    }
    async fileImports(): Promise<any[]> {
      return [];
    }
    async listFiles(): Promise<string[]> {
      return [];
    }
  },
}));

describe("createServer smoke test", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "token-pilot-server-"));
    mockState.root = tempDir;
    const appContent = Array.from(
      { length: 240 },
      (_, i) => `export const line${i} = ${i};`,
    ).join("\n");
    await writeFile(join(tempDir, "app.ts"), appContent);
    await writeFile(
      join(tempDir, "consumer.ts"),
      'import { app } from "./app";\napp();\n',
    );
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "smoke-app", version: "1.0.0" }),
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("starts a real MCP server, lists tools, and serves tool calls over a transport", async () => {
    const { createServer } = await import("../../src/server.js");
    const server = await createServer(tempDir);
    const client = new Client({ name: "smoke-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "smart_read")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "find_usages")).toBe(true);

    const readResult = await client.callTool({
      name: "smart_read",
      arguments: { path: "app.ts" },
    });
    expect(readResult.content?.[0]?.type).toBe("text");
    expect(readResult.content?.[0]?.text).toContain("TOKEN SAVINGS");

    const usagesResult = await client.callTool({
      name: "find_usages",
      arguments: { symbol: "app" },
    });
    expect(usagesResult.content?.[0]?.text).toContain('REFS: "app"');

    const analytics = await client.callTool({
      name: "session_analytics",
      arguments: {},
    });
    expect(analytics.content?.[0]?.text).toContain("smart_read 1×");
    expect(analytics.content?.[0]?.text).toContain("find_usages 1×");

    await Promise.all([client.close(), server.close()]);
  });
});
