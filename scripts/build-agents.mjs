#!/usr/bin/env node
/**
 * Phase 5 subtask 5.1 — render tp-* templates into agents/.
 *
 * Plain Node (ESM). Mirrors src/templates/agent-builder.ts composeAll
 * logic deliberately: this script runs before TypeScript compilation, so
 * it cannot import from src/. Drift between the two is caught by
 * tests/scripts/build-agents-parity.test.ts.
 *
 * Output location is the canonical Claude Code plugin convention:
 * `<repo-root>/agents/*.md`. Claude Code looks there by default on
 * plugin install (no `"agents"` field needed in plugin.json — the field
 * isn't part of the schema and was rejected by the validator in v0.27.0).
 *
 * Usage:
 *   node scripts/build-agents.mjs              # writes agents/*.md
 *   node scripts/build-agents.mjs --out=<dir>  # writes into <dir>/
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const TEMPLATES_DIR = join(REPO_ROOT, "templates", "agents");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "agents");

const FRONTMATTER_RE = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/;

function composeAgent(source, shared, contract) {
  const m = source.match(FRONTMATTER_RE);
  if (!m) {
    throw new Error(
      `build-agents: source has no frontmatter block (expected ---\\n...\\n---\\n)`,
    );
  }
  const [, frontmatter, roleBlock] = m;
  return (
    frontmatter +
    "\n" +
    shared.trim() +
    "\n\n" +
    roleBlock.trim() +
    "\n\n" +
    contract.trim() +
    "\n"
  );
}

function bodyHash(composed) {
  const m = composed.match(FRONTMATTER_RE);
  const body = m ? m[2] : composed;
  return createHash("sha256").update(body).digest("hex");
}

/**
 * v0.35.0 — per-agent frontmatter capabilities derived from Claude
 * Code's undocumented agent fields (memory / color / requiredMcpServers /
 * omitClaudeMd). All five tp-* agents below build a project-local
 * knowledge base across sessions, so a recurring task gets faster on
 * each repeat.
 */
const AGENT_MEMORY = {
  "tp-onboard": "project",
  "tp-debugger": "project",
  "tp-pr-reviewer": "project",
  "tp-history-explorer": "project",
  "tp-audit-scanner": "project",
};

/**
 * UI colour, picked by role family. Helps the user tell what a
 * dispatched subagent is going to do at a glance.
 */
const AGENT_COLOR = {
  // read / explore family — blue
  "tp-onboard": "blue",
  "tp-history-explorer": "blue",
  "tp-impact-analyzer": "blue",
  "tp-api-surface-tracker": "blue",
  "tp-session-restorer": "blue",
  // write / edit / refactor family — orange
  "tp-refactor-planner": "orange",
  "tp-incremental-builder": "orange",
  "tp-migration-scout": "orange",
  "tp-spec-writer": "orange",
  // review / audit family — red
  "tp-pr-reviewer": "red",
  "tp-audit-scanner": "red",
  "tp-review-impact": "red",
  "tp-test-triage": "red",
  "tp-dead-code-finder": "red",
  "tp-test-coverage-gapper": "red",
  // docs / wiki / context family — green
  "tp-doc-writer": "green",
  "tp-context-engineer": "green",
  // git / commit / release family — purple
  "tp-commit-writer": "purple",
  "tp-ship-coordinator": "purple",
  "tp-dep-health": "purple",
  // debug / diagnostics family — yellow
  "tp-debugger": "yellow",
  "tp-performance-profiler": "yellow",
  "tp-incident-timeline": "yellow",
  "tp-test-writer": "yellow",
  // catch-all
  "tp-run": "gray",
};

/**
 * Agents that should ignore project-level CLAUDE.md so they apply
 * generic industry standards rather than the user's project bias.
 * Currently just the security/quality audit scanner.
 */
const AGENT_OMIT_CLAUDE_MD = new Set(["tp-audit-scanner"]);

/**
 * Inject token_pilot install-marker fields into the frontmatter before
 * writing. install-agents reads these to decide idempotence states
 * (unchanged-installed / template-upgraded / user-edited) per Phase 5
 * idempotence contract.
 *
 * v0.35.0 — also inject the undocumented Claude Code agent fields
 * surfaced by reverse-engineering the 2.1.87 source (memory, color,
 * requiredMcpServers, omitClaudeMd). All additive — older Claude Code
 * versions ignore unknown frontmatter keys.
 */
function stampFrontmatter(composed, version, agentName) {
  const m = composed.match(FRONTMATTER_RE);
  if (!m) return composed;
  const [, fm, body] = m;
  const hash = createHash("sha256").update(body).digest("hex");
  // Insert marker lines immediately before the closing `---` delimiter.
  // Using lastIndexOf keeps any pre-existing newlines intact (earlier
  // regex replacement accidentally consumed the newline before `---`).
  const closeIdx = fm.lastIndexOf("---\n");
  if (closeIdx < 0) return composed;

  let extra =
    `token_pilot_version: "${version}"\n` +
    `token_pilot_body_hash: ${hash}\n`;

  // v0.35.0 — every tp-* agent declares the token-pilot MCP as a hard
  // requirement so Claude Code refuses to load it when the MCP isn't
  // configured. Prevents the "tools not found" UX when a user has the
  // agents installed but forgot to enable the plugin.
  extra +=
    `requiredMcpServers:\n` +
    `  - "token-pilot"\n`;

  if (agentName && AGENT_MEMORY[agentName]) {
    extra += `memory: ${AGENT_MEMORY[agentName]}\n`;
  }
  if (agentName && AGENT_COLOR[agentName]) {
    extra += `color: ${AGENT_COLOR[agentName]}\n`;
  }
  if (agentName && AGENT_OMIT_CLAUDE_MD.has(agentName)) {
    extra += `omitClaudeMd: true\n`;
  }

  const injected = fm.slice(0, closeIdx) + extra + fm.slice(closeIdx);
  return injected + body;
}

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT_DIR };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--out=")) args.out = resolve(a.slice(6));
  }
  return args;
}

function readVersion() {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf-8"),
  );
  return pkg.version;
}

function main() {
  const { out } = parseArgs(process.argv);

  const shared = readFileSync(
    join(TEMPLATES_DIR, "_shared-preamble.md"),
    "utf-8",
  );
  const contract = readFileSync(
    join(TEMPLATES_DIR, "_response-contract.md"),
    "utf-8",
  );
  const version = readVersion();

  mkdirSync(out, { recursive: true });

  const written = [];
  for (const entry of readdirSync(TEMPLATES_DIR)) {
    if (!entry.endsWith(".md")) continue;
    if (entry.startsWith("_")) continue;
    if (!entry.startsWith("tp-")) continue;

    const source = readFileSync(join(TEMPLATES_DIR, entry), "utf-8");
    const composed = composeAgent(source, shared, contract);
    const agentName = entry.replace(/\.md$/, "");
    const stamped = stampFrontmatter(composed, version, agentName);
    writeFileSync(join(out, entry), stamped);
    written.push(entry);
  }

  if (written.length === 0) {
    console.error("build-agents: no tp-*.md found in", TEMPLATES_DIR);
    process.exit(1);
  }

  console.error(
    `build-agents: wrote ${written.length} agent(s) to ${out} (version ${version})`,
  );
}

// Export for parity test; run main() only when invoked as a script.
export { composeAgent, bodyHash, stampFrontmatter };

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
