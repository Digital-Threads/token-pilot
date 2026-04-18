#!/usr/bin/env node
/**
 * postinstall — verify ast-index is usable, fall back to GitHub download.
 *
 * Runs after `npm install token-pilot` completes. npm has already pulled
 * @ast-index/cli + the platform-specific sub-package as a transitive dep;
 * this script only fires the GitHub fallback when that standard path
 * didn't land a usable binary (exotic arch, corporate proxy, etc.).
 *
 * NEVER fails npm install. On any error we print a single warning and
 * exit 0 — the `doctor` CLI still tells the user how to recover.
 */

import { access, constants } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");

// Opt-out hatch for CI, sandbox builds, etc.
if (
  process.env.TOKEN_PILOT_SKIP_POSTINSTALL === "1" ||
  process.env.CI === "true"
) {
  process.exit(0);
}

// dist/ must exist or auto-install falls through — for fresh source
// installs (cloned repo, pre-build), this is a no-op.
const binaryManagerPath = resolve(
  pkgRoot,
  "dist",
  "ast-index",
  "binary-manager.js",
);

try {
  await access(binaryManagerPath, constants.R_OK);
} catch {
  // Source checkout without dist/ — nothing for us to do.
  process.exit(0);
}

let BM;
try {
  BM = await import(binaryManagerPath);
} catch {
  process.exit(0);
}

try {
  const status = await BM.findBinary(null);
  if (status && status.available) {
    // Already good — the npm resolver handled everything.
    process.exit(0);
  }
} catch {
  /* fall through to install attempt */
}

// Try the explicit install path — logs to stderr, exit 0 regardless.
try {
  await BM.installBinary((msg) => {
    process.stderr.write(`[token-pilot postinstall] ${msg}\n`);
  });
  process.stderr.write("[token-pilot postinstall] ast-index ready.\n");
} catch (err) {
  const msg = err && err.message ? err.message : String(err);
  process.stderr.write(
    `[token-pilot postinstall] Could not auto-install ast-index (${msg}). ` +
      "Run \`npx token-pilot install-ast-index\` manually when ready; " +
      "token-pilot will still start but some tools degrade until the " +
      "binary is available.\n",
  );
}

process.exit(0);
