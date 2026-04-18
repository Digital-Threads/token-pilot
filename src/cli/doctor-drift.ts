/**
 * Phase 3 subtask 3.7 — drift detection for blessed agents.
 *
 * A blessed file records `token_pilot.upstream_hash` at bless time. If the
 * upstream (user or plugin scope) agent file changes later, our blessed copy
 * silently ages — users could be running on a definition that no longer
 * matches its upstream description or tool list. This function re-hashes
 * every upstream referenced by a blessed file and reports mismatches.
 *
 * Integration: called from `handleDoctor` after the other doctor checks.
 * Never throws; every error is swallowed and surfaced as a warning. Returns
 * an array so callers can test the findings without stubbing stderr.
 */

import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseFrontmatter } from "./agent-frontmatter.js";
import { scanAgents } from "./scan-agents.js";

export interface DriftFinding {
  agentName: string;
  blessedPath: string;
  upstreamScope: "user" | "plugin" | string;
  storedHash: string;
  currentHash: string | null;
  status: "drifted" | "missing-upstream" | "missing-fields";
}

export interface DetectDriftOptions {
  projectRoot: string;
  homeDir: string;
}

function currentBlessedHash(
  meta: Record<string, unknown>,
): { upstream: string; hash: string } | null {
  const tp = meta.token_pilot as Record<string, unknown> | undefined;
  if (!tp || tp.blessed !== true) return null;
  const upstream = typeof tp.upstream === "string" ? tp.upstream : null;
  const hash = typeof tp.upstream_hash === "string" ? tp.upstream_hash : null;
  if (!upstream || !hash) return null;
  return { upstream, hash };
}

async function sha256File(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, "utf-8");
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

export async function detectDrift(
  opts: DetectDriftOptions,
): Promise<DriftFinding[]> {
  const findings: DriftFinding[] = [];
  const projectAgentsDir = join(opts.projectRoot, ".claude", "agents");

  let blessedFiles: string[];
  try {
    const entries = await readdir(projectAgentsDir);
    blessedFiles = entries.filter((f) => f.endsWith(".md"));
  } catch {
    return findings;
  }

  // Build a single lookup from upstream scan for efficiency.
  let upstreamAgents: Awaited<ReturnType<typeof scanAgents>> = [];
  try {
    upstreamAgents = await scanAgents({
      projectRoot: opts.projectRoot,
      homeDir: opts.homeDir,
      pluginCacheGlob: [],
    });
  } catch {
    // If scan errors we can still report missing-upstream for each blessed
    // file; keep going with an empty lookup.
  }
  const upstreamByName = new Map(
    upstreamAgents
      .filter((a) => a.scope !== "project")
      .map((a) => [a.name + "::" + a.scope, a]),
  );

  for (const file of blessedFiles) {
    const fullPath = join(projectAgentsDir, file);
    const name = file.replace(/\.md$/, "");

    let meta: Record<string, unknown>;
    try {
      const body = await readFile(fullPath, "utf-8");
      ({ meta } = parseFrontmatter(body));
    } catch {
      continue;
    }

    const marker = currentBlessedHash(meta);
    if (!marker) continue;

    const upstream = upstreamByName.get(name + "::" + marker.upstream);
    if (!upstream) {
      findings.push({
        agentName: name,
        blessedPath: fullPath,
        upstreamScope: marker.upstream,
        storedHash: marker.hash,
        currentHash: null,
        status: "missing-upstream",
      });
      continue;
    }

    const currentHash = await sha256File(upstream.path);
    if (!currentHash) {
      findings.push({
        agentName: name,
        blessedPath: fullPath,
        upstreamScope: marker.upstream,
        storedHash: marker.hash,
        currentHash: null,
        status: "missing-upstream",
      });
      continue;
    }

    if (currentHash !== marker.hash) {
      findings.push({
        agentName: name,
        blessedPath: fullPath,
        upstreamScope: marker.upstream,
        storedHash: marker.hash,
        currentHash,
        status: "drifted",
      });
    }
  }

  return findings;
}

/**
 * Format a single finding as a human-readable stderr line.
 */
export function formatDriftFinding(f: DriftFinding): string {
  if (f.status === "drifted") {
    return (
      `⚠ tp-${f.agentName}: upstream changed since bless (scope=${f.upstreamScope}). ` +
      `Run: npx token-pilot bless-agents --re ${f.agentName}`
    );
  }
  if (f.status === "missing-upstream") {
    return (
      `⚠ tp-${f.agentName}: upstream no longer found (scope=${f.upstreamScope}). ` +
      `The blessed copy is orphaned; consider: npx token-pilot unbless-agents ${f.agentName}`
    );
  }
  return `⚠ tp-${f.agentName}: blessed frontmatter missing required fields`;
}
