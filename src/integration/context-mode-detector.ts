import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface ContextModeStatus {
  detected: boolean;
  source: 'mcp-json' | 'home-mcp-json' | 'config' | 'none';
  toolPrefix: string;
}

const TOOL_PREFIX = 'mcp__plugin_context-mode_context-mode__';

/**
 * Detect if context-mode MCP plugin is configured alongside Token Pilot.
 *
 * Checks two locations:
 *   1. Project-level .mcp.json (project root)
 *   2. User-level ~/.mcp.json (home dir)
 *
 * Returns detection result with source info.
 */
export async function detectContextMode(
  projectRoot: string,
  configOverride?: boolean,
): Promise<ContextModeStatus> {
  // Config override takes priority
  if (configOverride === true) {
    return { detected: true, source: 'config', toolPrefix: TOOL_PREFIX };
  }
  if (configOverride === false) {
    return { detected: false, source: 'none', toolPrefix: TOOL_PREFIX };
  }

  // Check project-level .mcp.json
  if (await checkMcpJson(resolve(projectRoot, '.mcp.json'))) {
    return { detected: true, source: 'mcp-json', toolPrefix: TOOL_PREFIX };
  }

  // Check user-level ~/.mcp.json
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (homeDir && await checkMcpJson(resolve(homeDir, '.mcp.json'))) {
    return { detected: true, source: 'home-mcp-json', toolPrefix: TOOL_PREFIX };
  }

  return { detected: false, source: 'none', toolPrefix: TOOL_PREFIX };
}

async function checkMcpJson(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, 'utf-8');
    const config = JSON.parse(raw);
    const servers = config.mcpServers ?? config.servers ?? {};

    // Look for any server entry containing "context-mode" in name or command
    for (const [name, server] of Object.entries(servers)) {
      if (name.includes('context-mode')) return true;
      const s = server as Record<string, any>;
      if (typeof s.command === 'string' && s.command.includes('context-mode')) return true;
      if (Array.isArray(s.args) && s.args.some((a: string) => String(a).includes('context-mode'))) return true;
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return false;
}
