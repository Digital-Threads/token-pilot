import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

vi.mock("../src/server.js", () => ({
  createServer: mockDeps.createServer,
}));

vi.mock("../src/hooks/installer.js", () => ({
  installHook: mockDeps.installHook,
  uninstallHook: mockDeps.uninstallHook,
}));

vi.mock("../src/ast-index/binary-manager.js", async () => {
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

vi.mock("../src/config/loader.js", () => ({
  loadConfig: mockDeps.loadConfig,
}));

vi.mock("../src/core/validation.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/core/validation.js")
  >("../src/core/validation.js");
  return {
    ...actual,
    isDangerousRoot: mockDeps.isDangerousRoot,
  };
});

vi.mock("../src/integration/context-mode-detector.js", () => ({
  detectContextMode: mockDeps.detectContextMode,
}));

import * as indexModule from "../src/index.ts";

describe("index CLI helpers", () => {
  let tempDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "token-pilot-index-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
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

    mockDeps.isDangerousRoot.mockImplementation((path: string) => path === "/");
    mockDeps.loadConfig.mockResolvedValue({
      astIndex: { binaryPath: null },
      updates: { checkOnStartup: false, autoUpdate: false },
      hooks: { denyThreshold: 300 },
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
      message: "hook skipped",
    });
    mockDeps.uninstallHook.mockResolvedValue({
      removed: false,
      fatal: false,
      message: "hook removed",
    });
    mockDeps.checkBinaryUpdate.mockResolvedValue({
      updateAvailable: false,
      current: "1.0.0",
      latest: "1.0.0",
    });
    mockDeps.isNewerVersion.mockReturnValue(false);
    mockDeps.detectContextMode.mockResolvedValue({
      detected: false,
      source: "none",
      toolPrefix: "",
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("dispatches version and help through main", async () => {
    await expect(indexModule.main(["--version"])).rejects.toThrow("EXIT:0");
    expect(logSpy).toHaveBeenCalled();

    await expect(indexModule.main(["--help"])).rejects.toThrow("EXIT:0");
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes("MCP Tools (22)"),
      ),
    ).toBe(true);
  });

  it("dispatches the default main path to server startup", async () => {
    const server = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    mockDeps.createServer.mockResolvedValue(server);

    await indexModule.main([tempDir]);
    expect(mockDeps.createServer).toHaveBeenCalledWith(tempDir, {
      enforcementMode: "deny",
      skipAstIndex: false,
    });
  });

  it("denies unbounded reads of large code files and allows small/non-code files", async () => {
    const largeFile = join(tempDir, "big.ts");
    const smallFile = join(tempDir, "small.ts");
    const mdFile = join(tempDir, "readme.md");
    await writeFile(
      largeFile,
      Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n"),
    );
    await writeFile(smallFile, "const x = 1;\n");
    await writeFile(mdFile, "# docs\n");

    await expect(
      indexModule.handleHookRead(mdFile, "deny-enhanced", 300, tempDir),
    ).rejects.toThrow("EXIT:0");
    expect(writeSpy).not.toHaveBeenCalled();

    await expect(
      indexModule.handleHookRead(smallFile, "deny-enhanced", 300, tempDir),
    ).rejects.toThrow("EXIT:0");
    expect(writeSpy).not.toHaveBeenCalled();

    await expect(
      indexModule.handleHookRead(largeFile, "deny-enhanced", 300, tempDir),
    ).rejects.toThrow("EXIT:0");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(String(writeSpy.mock.calls[0][0])).toContain(
      '"permissionDecision":"deny"',
    );
    expect(String(writeSpy.mock.calls[0][0])).toContain("smart_read");
  });

  it("respects configurable denyThreshold in handleHookRead", async () => {
    const borderFile = join(tempDir, "border.ts");
    await writeFile(
      borderFile,
      Array.from({ length: 350 }, (_, i) => `line ${i}`).join("\n"),
    );

    // Default threshold (300) — 350 lines should be denied in deny-enhanced mode.
    await expect(
      indexModule.handleHookRead(borderFile, "deny-enhanced", 300, tempDir),
    ).rejects.toThrow("EXIT:0");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(String(writeSpy.mock.calls[0][0])).toContain(
      '"permissionDecision":"deny"',
    );

    writeSpy.mockClear();

    // High threshold (500) — 350 lines now passes through.
    await expect(
      indexModule.handleHookRead(borderFile, "deny-enhanced", 500, tempDir),
    ).rejects.toThrow("EXIT:0");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("installs and uninstalls hooks with the returned fatal flag", async () => {
    mockDeps.installHook.mockResolvedValueOnce({
      installed: true,
      fatal: false,
      message: "installed",
    });
    await expect(indexModule.handleInstallHook(tempDir)).rejects.toThrow(
      "EXIT:0",
    );
    expect(logSpy).toHaveBeenCalledWith("installed");

    mockDeps.uninstallHook.mockResolvedValueOnce({
      removed: false,
      fatal: true,
      message: "broken",
    });
    await expect(indexModule.handleUninstallHook(tempDir)).rejects.toThrow(
      "EXIT:1",
    );
    expect(logSpy).toHaveBeenCalledWith("broken");
  });

  it("installs ast-index, reports up-to-date state, and handles failures", async () => {
    mockDeps.findBinary.mockResolvedValueOnce({
      available: true,
      path: "/bin/ast-index",
      version: "1.0.0",
      source: "PATH",
    });
    mockDeps.checkBinaryUpdate.mockResolvedValueOnce({
      updateAvailable: false,
      current: "1.0.0",
      latest: "1.0.0",
    });
    exitSpy.mockImplementationOnce(((code?: number) => {
      throw new Error(`EXIT:${code ?? 0}`);
    }) as never);
    await expect(indexModule.handleInstallAstIndex()).rejects.toThrow("EXIT:0");
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes("already up to date"),
      ),
    ).toBe(true);

    exitSpy.mockImplementation((() => undefined) as never);
    mockDeps.findBinary.mockResolvedValueOnce({
      available: false,
      path: null,
      version: null,
      source: null,
    });
    mockDeps.installBinary.mockResolvedValueOnce({
      path: "/bin/ast-index",
      version: "1.1.0",
    });
    await indexModule.handleInstallAstIndex();
    expect(exitSpy).toHaveBeenLastCalledWith(0);
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes("installed to /bin/ast-index"),
      ),
    ).toBe(true);

    mockDeps.findBinary.mockResolvedValueOnce({
      available: false,
      path: null,
      version: null,
      source: null,
    });
    mockDeps.installBinary.mockRejectedValueOnce(new Error("network failed"));
    await indexModule.handleInstallAstIndex();
    expect(exitSpy).toHaveBeenLastCalledWith(1);
    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes("network failed"),
      ),
    ).toBe(true);
  });

  it("creates and updates .mcp.json via init", async () => {
    await expect(indexModule.handleInit(tempDir)).rejects.toThrow("EXIT:0");
    const created = JSON.parse(
      await readFile(join(tempDir, ".mcp.json"), "utf-8"),
    );
    expect(created.mcpServers["token-pilot"]).toBeTruthy();
    expect(created.mcpServers["context-mode"]).toBeTruthy();

    await expect(indexModule.handleInit(tempDir)).rejects.toThrow("EXIT:0");
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes("already has both"),
      ),
    ).toBe(true);

    const partialDir = await mkdtemp(
      join(tmpdir(), "token-pilot-index-partial-"),
    );
    await writeFile(
      join(partialDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "token-pilot": { command: "npx", args: ["-y", "token-pilot"] },
        },
      }),
    );
    await expect(indexModule.handleInit(partialDir)).rejects.toThrow("EXIT:0");
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes(
          `Updated ${join(partialDir, ".mcp.json")} — added: context-mode`,
        ),
      ),
    ).toBe(true);
    await rm(partialDir, { recursive: true, force: true });

    const brokenDir = await mkdtemp(
      join(tmpdir(), "token-pilot-index-broken-"),
    );
    await writeFile(join(brokenDir, ".mcp.json"), "{bad json");
    await expect(indexModule.handleInit(brokenDir)).rejects.toThrow("EXIT:1");
    await rm(brokenDir, { recursive: true, force: true });
  });

  it("checks npm latest safely and reports updates on startup", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ version: "9.9.9" }),
      })
      .mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(indexModule.checkNpmLatest("token-pilot")).resolves.toBe(
      "9.9.9",
    );
    await expect(indexModule.checkNpmLatest("token-pilot")).resolves.toBeNull();
    await expect(indexModule.checkNpmLatest("token-pilot")).resolves.toBeNull();

    mockDeps.isNewerVersion.mockReturnValue(true);
    mockDeps.checkBinaryUpdate.mockResolvedValueOnce({
      updateAvailable: true,
      current: "1.0.0",
      latest: "1.1.0",
    });
    mockDeps.installBinary.mockResolvedValue({
      path: "/bin/ast-index",
      version: "1.1.0",
    });

    await indexModule.checkAllUpdates(
      { updates: { checkOnStartup: true, autoUpdate: true } } as any,
      { available: true, path: "/bin/ast-index" } as any,
    );
    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes("Auto-updating ast-index"),
      ),
    ).toBe(true);

    vi.unstubAllGlobals();
  });

  it("starts the server for explicit roots and warns on dangerous roots", async () => {
    const server = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    mockDeps.createServer.mockResolvedValue(server);
    mockDeps.installHook.mockResolvedValueOnce({
      installed: true,
      fatal: false,
      message: "hook installed",
    });

    await indexModule.startServer([tempDir]);
    expect(mockDeps.createServer).toHaveBeenCalledWith(tempDir, {
      enforcementMode: "deny",
      skipAstIndex: false,
    });
    expect(server.connect).toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes("hook auto-installed: hook installed"),
      ),
    ).toBe(true);

    await indexModule.startServer(["/"]);
    expect(
      errorSpy.mock.calls.some((call) => String(call[0]).includes("too broad")),
    ).toBe(true);
    expect(mockDeps.createServer).toHaveBeenCalledWith("/", {
      enforcementMode: "deny",
      skipAstIndex: true,
    });
  });

  it("auto-detects git root when started without explicit args", async () => {
    const repoDir = await realpath(
      await mkdtemp(join(tmpdir(), "token-pilot-index-git-")),
    );
    execFileSync("git", ["init"], { cwd: repoDir });
    const originalInitCwd = process.env.INIT_CWD;
    process.env.INIT_CWD = repoDir;

    const server = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    mockDeps.createServer.mockResolvedValue(server);

    await indexModule.startServer([]);
    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes(`project root: ${repoDir}`),
      ),
    ).toBe(true);
    expect(mockDeps.createServer).toHaveBeenCalledWith(repoDir, {
      enforcementMode: "deny",
      skipAstIndex: false,
    });

    process.env.INIT_CWD = originalInitCwd;
    await rm(repoDir, { recursive: true, force: true });
  });

  it("falls back to INIT_CWD when auto-detect cannot find a git root", async () => {
    const fallbackDir = await mkdtemp(
      join(tmpdir(), "token-pilot-index-fallback-"),
    );
    const originalInitCwd = process.env.INIT_CWD;
    const originalPwd = process.env.PWD;
    const originalCwd = process.cwd();
    process.env.INIT_CWD = fallbackDir;
    process.env.PWD = "/";
    process.chdir(fallbackDir);

    const server = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    mockDeps.createServer.mockResolvedValue(server);

    await indexModule.startServer([]);
    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes(`${fallbackDir} (INIT_CWD, not a git repo)`),
      ),
    ).toBe(true);
    expect(mockDeps.createServer).toHaveBeenCalledWith(fallbackDir, {
      enforcementMode: "deny",
      skipAstIndex: false,
    });

    process.env.INIT_CWD = originalInitCwd;
    process.env.PWD = originalPwd;
    process.chdir(originalCwd);
    await rm(fallbackDir, { recursive: true, force: true });
  });

  it("prints doctor diagnostics for installed components", async () => {
    exitSpy.mockImplementationOnce(((code?: number) => {
      throw new Error(`EXIT:${code ?? 0}`);
    }) as never);

    const originalCwd = process.cwd();
    process.chdir(tempDir);
    await writeFile(join(tempDir, ".token-pilot.json"), "{}");
    await writeFile(join(tempDir, ".git"), "");

    mockDeps.findBinary.mockResolvedValueOnce({
      available: true,
      path: "/bin/ast-index",
      version: "1.0.0",
      source: "PATH",
    });
    mockDeps.checkBinaryUpdate.mockResolvedValueOnce({
      updateAvailable: true,
      current: "1.0.0",
      latest: "1.1.0",
    });
    mockDeps.loadConfig.mockResolvedValueOnce({
      updates: { autoUpdate: true },
    });
    mockDeps.detectContextMode.mockResolvedValueOnce({
      detected: true,
      source: "mcp-json",
      toolPrefix: "cm__",
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ version: "9.9.9" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ version: "3.3.3" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    mockDeps.isNewerVersion.mockReturnValue(true);

    await expect(indexModule.handleDoctor()).rejects.toThrow("EXIT:0");
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes("token-pilot doctor"),
      ),
    ).toBe(true);
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes("latest:       9.9.9"),
      ),
    ).toBe(true);
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes("auto-update:  enabled"),
      ),
    ).toBe(true);
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes("detected:     yes (mcp-json)"),
      ),
    ).toBe(true);

    vi.unstubAllGlobals();
    process.chdir(originalCwd);
  });

  it("prints doctor setup guidance when context-mode is missing", async () => {
    exitSpy.mockImplementationOnce(((code?: number) => {
      throw new Error(`EXIT:${code ?? 0}`);
    }) as never);

    const originalCwd = process.cwd();
    process.chdir(tempDir);
    mockDeps.findBinary.mockResolvedValueOnce({
      available: false,
      path: null,
      version: null,
      source: null,
    });
    mockDeps.detectContextMode.mockResolvedValueOnce({
      detected: false,
      source: "none",
      toolPrefix: "",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    await expect(indexModule.handleDoctor()).rejects.toThrow("EXIT:0");
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes("setup:        npx token-pilot init"),
      ),
    ).toBe(true);

    vi.unstubAllGlobals();
    process.chdir(originalCwd);
  });

  it("logs non-auto ast-index updates without forcing installation", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ version: "9.9.9" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ version: "3.3.3" }),
        }),
    );
    mockDeps.isNewerVersion.mockReturnValue(true);
    mockDeps.checkBinaryUpdate.mockResolvedValueOnce({
      updateAvailable: true,
      current: "1.0.0",
      latest: "1.2.0",
    });

    await indexModule.checkAllUpdates(
      { updates: { checkOnStartup: true, autoUpdate: false } } as any,
      { available: true, path: "/bin/ast-index" } as any,
    );

    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes("ast-index update: 1.0.0 → 1.2.0"),
      ),
    ).toBe(true);
    expect(mockDeps.installBinary).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
