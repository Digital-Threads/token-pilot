import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ContextModeStatus {
  detected: boolean;
  source: "mcp-json" | "home-mcp-json" | "plugin" | "config" | "none";
  toolPrefix: string;
}

const TOOL_PREFIX = "mcp__plugin_context-mode_context-mode__";

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

/**
 * Plugin ids ("name@marketplace") switched on in Claude Code settings. Later
 * files win: user (~/.claude or CLAUDE_CONFIG_DIR), then project, then
 * project-local — the order Claude Code applies them.
 */
export function enabledPluginIds(projectRoot: string): string[] {
  const userDir = process.env.CLAUDE_CONFIG_DIR || (homeDir() && resolve(homeDir(), ".claude"));
  const files = [
    userDir ? resolve(userDir, "settings.json") : "",
    resolve(projectRoot, ".claude", "settings.json"),
    resolve(projectRoot, ".claude", "settings.local.json"),
  ].filter(Boolean);

  const state = new Map<string, boolean>();
  for (const file of files) {
    try {
      const plugins = JSON.parse(readFileSync(file, "utf-8")).enabledPlugins;
      if (!plugins || typeof plugins !== "object") continue;
      for (const [id, on] of Object.entries(plugins)) state.set(id, on === true);
    } catch {
      /* missing / malformed */
    }
  }

  return [...state].filter(([, on]) => on).map(([id]) => id);
}

function contextModePluginEnabled(projectRoot: string): boolean {
  return enabledPluginIds(projectRoot).some((id) => id.startsWith("context-mode@"));
}

/**
 * Detect if context-mode is available alongside Token Pilot.
 *
 * Checks, in order:
 *   1. Project-level .mcp.json (project root)
 *   2. User-level ~/.mcp.json (home dir)
 *   3. A context-mode Claude Code plugin enabled in settings
 *
 * Returns detection result with source info.
 */
export async function detectContextMode(
  projectRoot: string,
  configOverride?: boolean,
): Promise<ContextModeStatus> {
  // Config override takes priority
  if (configOverride === true) {
    return { detected: true, source: "config", toolPrefix: TOOL_PREFIX };
  }
  if (configOverride === false) {
    return { detected: false, source: "none", toolPrefix: TOOL_PREFIX };
  }

  // Check project-level .mcp.json
  if (await checkMcpJson(resolve(projectRoot, ".mcp.json"))) {
    return { detected: true, source: "mcp-json", toolPrefix: TOOL_PREFIX };
  }

  // Check user-level ~/.mcp.json
  const home = homeDir();
  if (home && (await checkMcpJson(resolve(home, ".mcp.json")))) {
    return { detected: true, source: "home-mcp-json", toolPrefix: TOOL_PREFIX };
  }

  if (contextModePluginEnabled(projectRoot)) {
    return { detected: true, source: "plugin", toolPrefix: TOOL_PREFIX };
  }

  return { detected: false, source: "none", toolPrefix: TOOL_PREFIX };
}

/**
 * context-mode's execute tool as this install names it — the plugin's tool
 * when the plugin is on in the merged Claude Code settings, the bare
 * server's when a `.mcp.json` registers it — or undefined when it is not
 * installed. Sync, for the PostToolUse Bash hook; silent on every failure.
 */
export function contextModeExecuteTool(projectRoot: string): string | undefined {
  if (contextModePluginEnabled(projectRoot)) return `${TOOL_PREFIX}ctx_execute`;

  const home = homeDir();
  if (checkMcpJsonSync(resolve(projectRoot, ".mcp.json")) || (home && checkMcpJsonSync(resolve(home, ".mcp.json")))) {
    return "mcp__context-mode__ctx_execute";
  }

  return undefined;
}

function checkMcpJsonSync(path: string): boolean {
  try {
    const raw = readFileSync(path, "utf-8");
    const config = JSON.parse(raw);
    const servers = config.mcpServers ?? config.servers ?? {};
    for (const [name, server] of Object.entries(servers)) {
      if (name.includes("context-mode")) return true;
      const s = server as Record<string, any>;
      if (typeof s.command === "string" && s.command.includes("context-mode"))
        return true;
      if (
        Array.isArray(s.args) &&
        s.args.some((a: string) => String(a).includes("context-mode"))
      )
        return true;
    }
  } catch {
    /* missing / malformed */
  }
  return false;
}

async function checkMcpJson(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf-8");
    const config = JSON.parse(raw);
    const servers = config.mcpServers ?? config.servers ?? {};

    // Look for any server entry containing "context-mode" in name or command
    for (const [name, server] of Object.entries(servers)) {
      if (name.includes("context-mode")) return true;
      const s = server as Record<string, any>;
      if (typeof s.command === "string" && s.command.includes("context-mode"))
        return true;
      if (
        Array.isArray(s.args) &&
        s.args.some((a: string) => String(a).includes("context-mode"))
      )
        return true;
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return false;
}
