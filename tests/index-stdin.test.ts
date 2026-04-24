import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDeps = vi.hoisted(() => ({
  createServer: vi.fn(),
  installHook: vi.fn(),
  uninstallHook: vi.fn(),
  findBinary: vi.fn(),
  installBinary: vi.fn(),
  checkBinaryUpdate: vi.fn(),
  isNewerVersion: vi.fn(),
  loadConfig: vi.fn(),
  isDangerousRoot: vi.fn(),
  detectContextMode: vi.fn(),
}));

async function loadIndexWithReadFile(
  mockReadFileSync: ReturnType<typeof vi.fn>,
) {
  vi.resetModules();

  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...actual,
      readFileSync: mockReadFileSync,
    };
  });

  vi.doMock("../src/server.js", () => ({
    createServer: mockDeps.createServer,
  }));

  vi.doMock("../src/hooks/installer.js", () => ({
    installHook: mockDeps.installHook,
    uninstallHook: mockDeps.uninstallHook,
  }));

  vi.doMock("../src/ast-index/binary-manager.js", async () => {
    const actual = await vi.importActual<
      typeof import("../src/ast-index/binary-manager.js")
    >("../src/ast-index/binary-manager.js");
    return {
      ...actual,
      findBinary: mockDeps.findBinary,
      installBinary: mockDeps.installBinary,
      checkBinaryUpdate: mockDeps.checkBinaryUpdate,
      isNewerVersion: mockDeps.isNewerVersion,
    };
  });

  vi.doMock("../src/config/loader.js", () => ({
    loadConfig: mockDeps.loadConfig,
  }));

  vi.doMock("../src/core/validation.js", async () => {
    const actual = await vi.importActual<
      typeof import("../src/core/validation.js")
    >("../src/core/validation.js");
    return {
      ...actual,
      isDangerousRoot: mockDeps.isDangerousRoot,
    };
  });

  vi.doMock("../src/integration/context-mode-detector.js", () => ({
    detectContextMode: mockDeps.detectContextMode,
  }));

  return import("../src/index.ts");
}

async function loadIndexFresh() {
  vi.resetModules();

  vi.doMock("../src/server.js", () => ({
    createServer: mockDeps.createServer,
  }));

  vi.doMock("../src/hooks/installer.js", () => ({
    installHook: mockDeps.installHook,
    uninstallHook: mockDeps.uninstallHook,
  }));

  vi.doMock("../src/ast-index/binary-manager.js", async () => {
    const actual = await vi.importActual<
      typeof import("../src/ast-index/binary-manager.js")
    >("../src/ast-index/binary-manager.js");
    return {
      ...actual,
      findBinary: mockDeps.findBinary,
      installBinary: mockDeps.installBinary,
      checkBinaryUpdate: mockDeps.checkBinaryUpdate,
      isNewerVersion: mockDeps.isNewerVersion,
    };
  });

  vi.doMock("../src/config/loader.js", () => ({
    loadConfig: mockDeps.loadConfig,
  }));

  vi.doMock("../src/core/validation.js", async () => {
    const actual = await vi.importActual<
      typeof import("../src/core/validation.js")
    >("../src/core/validation.js");
    return {
      ...actual,
      isDangerousRoot: mockDeps.isDangerousRoot,
    };
  });

  vi.doMock("../src/integration/context-mode-detector.js", () => ({
    detectContextMode: mockDeps.detectContextMode,
  }));

  return import("../src/index.ts");
}

describe("index stdin hooks", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code ?? 0}`);
    }) as never);

    mockDeps.createServer.mockReset();
    mockDeps.installHook.mockReset();
    mockDeps.uninstallHook.mockReset();
    mockDeps.findBinary.mockReset();
    mockDeps.installBinary.mockReset();
    mockDeps.checkBinaryUpdate.mockReset();
    mockDeps.isNewerVersion.mockReset();
    mockDeps.loadConfig.mockReset();
    mockDeps.isDangerousRoot.mockReset();
    mockDeps.detectContextMode.mockReset();
    mockDeps.isDangerousRoot.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("allows bounded hook-read requests from stdin and exits quietly on invalid input", async () => {
    const boundedRead = vi.fn((path: string | number) => {
      if (path === 0) {
        return JSON.stringify({
          tool_input: {
            file_path: "/repo/big.ts",
            offset: 20,
          },
        });
      }
      return "";
    });
    const boundedModule = await loadIndexWithReadFile(boundedRead);
    await expect(boundedModule.handleHookRead()).rejects.toThrow("EXIT:0");
    expect(writeSpy).not.toHaveBeenCalled();

    const invalidRead = vi.fn(() => "{bad json");
    const invalidModule = await loadIndexWithReadFile(invalidRead);
    await expect(invalidModule.handleHookRead()).rejects.toThrow("EXIT:0");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("denies large unbounded code reads parsed from stdin", async () => {
    // Real on-disk file so the hook's path-safety check can resolve it.
    const fixtureRoot = await mkdtemp(join(tmpdir(), "tp-stdin-"));
    const filePath = join(fixtureRoot, "huge.ts");
    await writeFile(
      filePath,
      Array.from({ length: 700 }, (_, i) => `line ${i}`).join("\n"),
    );

    const stdinAndFile = vi.fn((path: string | number) => {
      if (path === 0) {
        return JSON.stringify({
          tool_input: {
            file_path: filePath,
          },
        });
      }
      if (path === filePath) {
        return Array.from({ length: 700 }, (_, i) => `line ${i}`).join("\n");
      }
      return "";
    });

    const mod = await loadIndexWithReadFile(stdinAndFile);
    // projectRoot passed explicitly so path-safety accepts the tmp fixture.
    const result = await mod.runHookReadDispatch(
      undefined,
      "deny-enhanced",
      300,
      fixtureRoot,
    );
    expect(result).not.toBeNull();
    expect(String(result)).toContain('"permissionDecision":"deny"');
    expect(String(result)).toContain("read_for_edit");

    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("edit hook: silent on non-existent code files (hook falls through to Claude Code's own error)", async () => {
    // v0.30.0 — the old behaviour always emitted an allow+TIP. New
    // behaviour only emits when there is enforcement work to do: denying
    // an unprepared edit on an existing file, or routing an advisory
    // hint. A non-existent path is out of scope — Claude Code's Edit
    // tool produces a clearer error itself.
    const codeEditRead = vi.fn(() =>
      JSON.stringify({
        tool_input: {
          file_path: "/repo/does-not-exist/file.ts",
        },
      }),
    );
    const codeModule = await loadIndexWithReadFile(codeEditRead);
    expect(() => codeModule.handleHookEdit()).toThrow("EXIT:0");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("edit hook: skips non-code files (configs, docs, JSON)", async () => {
    const docEditRead = vi.fn(() =>
      JSON.stringify({
        tool_input: {
          file_path: "/repo/file.md",
        },
      }),
    );
    const docModule = await loadIndexWithReadFile(docEditRead);
    expect(() => docModule.handleHookEdit()).toThrow("EXIT:0");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("edit hook: silently passes malformed stdin through", async () => {
    const invalidRead = vi.fn(() => "{bad json");
    const invalidModule = await loadIndexWithReadFile(invalidRead);
    expect(() => invalidModule.handleHookEdit()).toThrow("EXIT:0");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("edit hook: denies Edit on an existing un-prepared code file (TOKEN_PILOT_MODE=deny)", async () => {
    // Concrete on-disk fixture: the new hook calls existsSync, so we need
    // a real file. A separate prep-state roundtrip is covered by the
    // edit-prep-state unit suite; here we only exercise the hook wrapper
    // and the deny render path.
    const fixtureRoot = await mkdtemp(join(tmpdir(), "token-pilot-edit-hook-"));
    try {
      const filePath = join(fixtureRoot, "app.ts");
      await writeFile(filePath, "export const x = 1;\n");
      const read = vi.fn(() =>
        JSON.stringify({
          tool_name: "Edit",
          tool_input: { file_path: filePath },
        }),
      );
      const mod = await loadIndexWithReadFile(read);
      // Default mode is "deny" when TOKEN_PILOT_MODE is unset.
      expect(() => mod.handleHookEdit()).toThrow("EXIT:0");
      expect(writeSpy).toHaveBeenCalledTimes(1);
      const payload = String(writeSpy.mock.calls[0][0]);
      expect(payload).toContain('"permissionDecision":"deny"');
      expect(payload).toContain("read_for_edit");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("auto-runs main when imported directly and reports fatal startup failures", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "token-pilot-index-direct-"));
    const modulePath = fileURLToPath(
      new URL("../src/index.ts", import.meta.url),
    );
    const originalArgv = [...process.argv];

    try {
      const server = {
        connect: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      };
      mockDeps.createServer.mockResolvedValueOnce(server);
      mockDeps.loadConfig.mockResolvedValue({
        astIndex: { binaryPath: null },
        updates: { checkOnStartup: false, autoUpdate: false },
      });
      mockDeps.findBinary.mockResolvedValue({
        available: false,
        path: null,
        version: null,
        source: null,
      });
      mockDeps.installHook.mockResolvedValue({
        installed: false,
        fatal: false,
        message: "skipped",
      });

      process.argv = ["node", modulePath, tempDir];
      await loadIndexFresh();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockDeps.createServer).toHaveBeenCalledWith(tempDir, {
        enforcementMode: "deny",
        skipAstIndex: false,
      });

      vi.resetModules();
      mockDeps.createServer.mockRejectedValueOnce(new Error("startup failed"));
      exitSpy.mockImplementation((() => undefined) as never);
      process.argv = ["node", modulePath, tempDir];
      await loadIndexFresh();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        errorSpy.mock.calls.some((call) =>
          String(call[0]).includes("Fatal: startup failed"),
        ),
      ).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      process.argv = originalArgv;
      await rm(tempDir, { recursive: true, force: true });
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");
    }
  });
});
