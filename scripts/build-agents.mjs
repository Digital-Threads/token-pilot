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
 * Inject token_pilot install-marker fields into the frontmatter before
 * writing. install-agents reads these to decide idempotence states
 * (unchanged-installed / template-upgraded / user-edited) per Phase 5
 * idempotence contract.
 */
function stampFrontmatter(composed, version) {
  const m = composed.match(FRONTMATTER_RE);
  if (!m) return composed;
  const [, fm, body] = m;
  const hash = createHash("sha256").update(body).digest("hex");
  // Insert marker lines immediately before the closing `---` delimiter.
  // Using lastIndexOf keeps any pre-existing newlines intact (earlier
  // regex replacement accidentally consumed the newline before `---`).
  const closeIdx = fm.lastIndexOf("---\n");
  if (closeIdx < 0) return composed;
  const injected =
    fm.slice(0, closeIdx) +
    `token_pilot_version: "${version}"\n` +
    `token_pilot_body_hash: ${hash}\n` +
    fm.slice(closeIdx);
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
    const stamped = stampFrontmatter(composed, version);
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
