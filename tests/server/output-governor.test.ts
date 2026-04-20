/**
 * v0.30.0 PR #5 — Output governor: strict-mode arg injection.
 *
 * Verifies that in strict mode:
 *   - find_usages gets mode="list" injected when caller didn't set it
 *   - smart_log gets count=20 injected when caller didn't set it
 *   - explicit caller params are NOT overridden
 *   - advisory/deny modes receive no injection
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { EnforcementMode } from "../../src/server/enforcement-mode.js";

// ── hoisted mocks ──────────────────────────────────────────────────────────

const mockHandlers = vi.hoisted(() => ({
  findUsages: vi.fn(),
  smartLog: vi.fn(),
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
    async outline(): Promise<null> {
      return null;
    }
    async refs(): Promise<{ definitions: []; imports: []; usages: [] }> {
      return { definitions: [], imports: [], usages: [] };
    }
    async search(): Promise<[]> {
      return [];
    }
    async map(): Promise<null> {
      return null;
    }
    async conventions(): Promise<null> {
      return null;
    }
    async stats(): Promise<null> {
      return null;
    }
    async fileImports(): Promise<[]> {
      return [];
    }
    async listFiles(): Promise<[]> {
      return [];
    }
  },
}));

vi.mock("../../src/handlers/find-usages.js", () => ({
  handleFindUsages: mockHandlers.findUsages,
}));

vi.mock("../../src/handlers/smart-log.js", () => ({
  handleSmartLog: mockHandlers.smartLog,
}));

// ── test helpers ──────────────────────────────────────────────────────────

import { createServer } from "../../src/server.js";

async function makeClient(enforcementMode: EnforcementMode) {
  const tempDir = await mkdtemp(join(tmpdir(), "tp-gov-"));
  await writeFile(
    join(tempDir, "package.json"),
    JSON.stringify({ name: "gov-test", version: "1.0.0" }),
  );
  const server = await createServer(tempDir, { enforcementMode });
  const client = new Client({ name: "gov-client", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return {
    client,
    server,
    async close() {
      await Promise.all([client.close(), server.close()]);
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

// ── find_usages ────────────────────────────────────────────────────────────

describe("output governor — find_usages", () => {
  beforeEach(() => {
    mockHandlers.findUsages.mockReset();
    mockHandlers.findUsages.mockImplementation(async (args: any) => ({
      content: [
        {
          type: "text",
          text: `REFS: "${args.symbol}" mode=${args.mode ?? "unset"}`,
        },
      ],
      meta: { files: [] },
    }));
  });

  it("strict: injects mode=list when caller omits it", async () => {
    const ctx = await makeClient("strict");
    try {
      const result = await ctx.client.callTool({
        name: "find_usages",
        arguments: { symbol: "foo" },
      });
      const text = result.content?.[0]?.text ?? "";
      // Handler received mode="list"
      expect(mockHandlers.findUsages).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "list" }),
        expect.anything(),
        expect.anything(),
      );
      // Advisory note appended
      expect(text).toContain("[token-pilot strict]");
      expect(text).toContain('find_usages mode defaulted to "list"');
      expect(text).toContain("TOKEN_PILOT_MODE=strict");
    } finally {
      await ctx.close();
    }
  });

  it("strict: does NOT override explicit mode=full", async () => {
    const ctx = await makeClient("strict");
    try {
      const result = await ctx.client.callTool({
        name: "find_usages",
        arguments: { symbol: "foo", mode: "full" },
      });
      const text = result.content?.[0]?.text ?? "";
      expect(mockHandlers.findUsages).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "full" }),
        expect.anything(),
        expect.anything(),
      );
      // No strict note when caller was explicit
      expect(text).not.toContain("[token-pilot strict]");
    } finally {
      await ctx.close();
    }
  });

  it("deny: no injection (mode stays undefined)", async () => {
    const ctx = await makeClient("deny");
    try {
      await ctx.client.callTool({
        name: "find_usages",
        arguments: { symbol: "foo" },
      });
      expect(mockHandlers.findUsages).toHaveBeenCalledWith(
        expect.objectContaining({ mode: undefined }),
        expect.anything(),
        expect.anything(),
      );
    } finally {
      await ctx.close();
    }
  });

  it("advisory: no injection (mode stays undefined)", async () => {
    const ctx = await makeClient("advisory");
    try {
      await ctx.client.callTool({
        name: "find_usages",
        arguments: { symbol: "foo" },
      });
      expect(mockHandlers.findUsages).toHaveBeenCalledWith(
        expect.objectContaining({ mode: undefined }),
        expect.anything(),
        expect.anything(),
      );
    } finally {
      await ctx.close();
    }
  });
});

// ── smart_log ──────────────────────────────────────────────────────────────

describe("output governor — smart_log", () => {
  beforeEach(() => {
    mockHandlers.smartLog.mockReset();
    mockHandlers.smartLog.mockImplementation(async (args: any) => ({
      content: [
        {
          type: "text",
          text: `LOG count=${args.count ?? "unset"}`,
        },
      ],
      rawTokens: 50,
    }));
  });

  it("strict: injects count=20 when caller omits it", async () => {
    const ctx = await makeClient("strict");
    try {
      const result = await ctx.client.callTool({
        name: "smart_log",
        arguments: {},
      });
      const text = result.content?.[0]?.text ?? "";
      // Handler received count=20
      expect(mockHandlers.smartLog).toHaveBeenCalledWith(
        expect.objectContaining({ count: 20 }),
        expect.anything(),
      );
      // Advisory note appended
      expect(text).toContain("[token-pilot strict]");
      expect(text).toContain("smart_log count defaulted to 20");
      expect(text).toContain("TOKEN_PILOT_MODE=strict");
    } finally {
      await ctx.close();
    }
  });

  it("strict: does NOT override explicit count=5", async () => {
    const ctx = await makeClient("strict");
    try {
      const result = await ctx.client.callTool({
        name: "smart_log",
        arguments: { count: 5 },
      });
      const text = result.content?.[0]?.text ?? "";
      expect(mockHandlers.smartLog).toHaveBeenCalledWith(
        expect.objectContaining({ count: 5 }),
        expect.anything(),
      );
      expect(text).not.toContain("[token-pilot strict]");
    } finally {
      await ctx.close();
    }
  });

  it("deny: no injection (count stays undefined)", async () => {
    const ctx = await makeClient("deny");
    try {
      await ctx.client.callTool({
        name: "smart_log",
        arguments: {},
      });
      expect(mockHandlers.smartLog).toHaveBeenCalledWith(
        expect.objectContaining({ count: undefined }),
        expect.anything(),
      );
    } finally {
      await ctx.close();
    }
  });

  it("advisory: no injection (count stays undefined)", async () => {
    const ctx = await makeClient("advisory");
    try {
      await ctx.client.callTool({
        name: "smart_log",
        arguments: {},
      });
      expect(mockHandlers.smartLog).toHaveBeenCalledWith(
        expect.objectContaining({ count: undefined }),
        expect.anything(),
      );
    } finally {
      await ctx.close();
    }
  });
});
