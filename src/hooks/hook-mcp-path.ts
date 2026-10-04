/**
 * Standalone entry for the MCP path hook (see mcp-path.ts).
 *
 * The hook fires on every token-pilot tool call, and in almost every session
 * it has nothing to do. Routed through dist/index.js it would load the whole
 * CLI first — about 200 ms per call, measured — where this file loads one
 * small module: about 25 ms. The file name keeps the `hook-` token so the
 * duplicate-registration detector still recognises the entry as ours.
 *
 * It never fails the call it guards: anything unexpected means "no opinion"
 * and the tool call goes ahead unchanged.
 */

import { readFileSync } from "node:fs";
import { findCheckout } from "./find-checkout.js";
import { decideMcpPath, renderMcpPathOutput } from "./mcp-path.js";

try {
  const input = JSON.parse(readFileSync(0, "utf-8"));
  const decision = decideMcpPath(input, {
    projectRoot: process.env.CLAUDE_PROJECT_DIR,
    checkoutOf: findCheckout,
  });

  const rendered = renderMcpPathOutput(decision);
  if (rendered) process.stdout.write(rendered);
} catch {
  // No opinion.
}
