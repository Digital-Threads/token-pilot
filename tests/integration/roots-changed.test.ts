import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

/**
 * v0.48.0 — a session that starts in a dangerous root (`/`, home) gets a
 * single auto-detect attempt. When the real project arrives later via
 * `/add-dir`, that attempt is already spent and ast-index stays disabled
 * for the rest of the session. Claude Code 2.1.203+ sends
 * `notifications/roots/list_changed` whenever the working-directory set
 * changes — verified present in the 2.1.220 bundle — so the server can
 * re-arm detection instead of staying blind.
 */
const mockState = vi.hoisted(() => ({
  /** Roots the fake client currently advertises. */
  roots: [] as { uri: string; name: string }[],
  /** Every projectRoot the server pushed into ast-index. */
  appliedRoots: [] as string[],
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
    updateProjectRoot(root: string): void {
      mockState.appliedRoots.push(root);
    }
    async incrementalUpdate(): Promise<void> {}
    startPeriodicUpdate(): void {}
    stopPeriodicUpdate(): void {}
  },
}));

describe("roots/list_changed re-arms project-root detection", () => {
  let tempDir: string;

  /** Boot a server in auto-detect mode wired to a roots-capable client. */
  async function connect(startRoot: string) {
    const { createServer } = await import("../../src/server.js");
    const server = await createServer(startRoot, { skipAstIndex: true });
    const client = new Client(
      { name: "roots-client", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } },
    );
    client.setRequestHandler(
      (await import("@modelcontextprotocol/sdk/types.js")).ListRootsRequestSchema,
      async () => ({ roots: mockState.roots }),
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return { server, client };
  }

  /** The notification is fire-and-forget; give the handler a tick to run. */
  async function settle() {
    await new Promise((r) => setTimeout(r, 50));
  }

  /**
   * Detection is lazy — it runs on the first tool call, not at startup.
   * Any call spends the single attempt, so this is how a real session
   * reaches the "already tried, gave up" state.
   */
  async function spendDetectionAttempt(client: Client) {
    await client
      .callTool({ name: "session_budget", arguments: {} })
      .catch(() => undefined);
    await settle();
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tp-roots-"));
    await writeFile(join(tempDir, "app.ts"), "export const a = 1;\n");
    mockState.roots = [];
    mockState.appliedRoots = [];
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("adopts a usable root that only appears after the first attempt", async () => {
    // The client advertises nothing, so the one detection attempt fails.
    const { client } = await connect("/");
    await spendDetectionAttempt(client);
    expect(mockState.appliedRoots).toEqual([]);

    // The user runs /add-dir — the real project shows up.
    mockState.roots = [{ uri: `file://${tempDir}`, name: "project" }];
    await client.sendRootsListChanged();
    await settle();

    expect(mockState.appliedRoots).toContain(tempDir);
  });

  it("keeps a resolved root when more directories are added later", async () => {
    // The first attempt already finds the project, so ast-index is set.
    mockState.roots = [{ uri: `file://${tempDir}`, name: "project" }];
    const { client } = await connect("/");
    await spendDetectionAttempt(client);
    expect(mockState.appliedRoots).toEqual([tempDir]);

    // Adding a second directory must not re-point a healthy session.
    const second = await mkdtemp(join(tmpdir(), "tp-roots-second-"));
    try {
      mockState.roots = [
        { uri: `file://${second}`, name: "second" },
        { uri: `file://${tempDir}`, name: "project" },
      ];
      await client.sendRootsListChanged();
      await settle();

      expect(mockState.appliedRoots).toEqual([tempDir]);
    } finally {
      await rm(second, { recursive: true, force: true });
    }
  });
});
