/**
 * Node loader for the tp-* agent index. The parsing lives in
 * agent-matcher.ts, which stays free of Node for the Claude Code mod.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { buildAgentIndexFromFiles, type AgentIndex } from "./agent-matcher.js";

/**
 * Read tp-*.md from `agentsDir`. A missing directory or an unreadable file is
 * skipped, never thrown — an agent directory isn't a runtime dependency.
 */
export async function buildAgentIndex(agentsDir: string): Promise<AgentIndex> {
  let entries: string[];
  try {
    entries = await fs.readdir(agentsDir);
  } catch {
    return { agents: [] };
  }

  const files: Array<{ fileName: string; body: string }> = [];
  for (const fileName of entries) {
    if (!fileName.startsWith("tp-") || !fileName.endsWith(".md")) continue;
    try {
      files.push({ fileName, body: await fs.readFile(join(agentsDir, fileName), "utf-8") });
    } catch {
      /* unreadable — skip */
    }
  }

  return buildAgentIndexFromFiles(files);
}
