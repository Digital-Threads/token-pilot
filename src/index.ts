#!/usr/bin/env node

// v0.26.6 — handle EPIPE silently. Piping `token-pilot doctor | head -5`
// causes EPIPE once head closes stdin. Classic Node.js CLI wart. Default
// behaviour is a red "throw er; // Unhandled 'error' event" stacktrace,
// which scares users who just wanted a quick look. Standard fix: swallow
// EPIPE on stdout/stderr and exit 0 — any CLI piped to head|less|grep
// behaves this way.
process.stdout.on("error", (err) => {
  if ((err as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
  throw err;
});
process.stderr.on("error", (err) => {
  if ((err as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
  throw err;
});

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  existsSync,
  readFileSync,
  realpathSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "./server.js";
import {
  installHook,
  uninstallHook,
  cleanStaleHookEntries,
  isTokenPilotPluginEnabled,
} from "./hooks/installer.js";
import { runHookEntryPoint } from "./hooks/safe-runner.js";
import { loadErrors, formatErrorList } from "./core/error-log.js";
import { appendDiagnostic } from "./core/event-log.js";
import {
  startWorkflow,
  endWorkflow,
  listWorkflows,
  workflowStatus,
  formatWorkflowStatus,
  formatWorkflowList,
} from "./core/workflow.js";
import {
  findBinary,
  installBinary,
  checkBinaryUpdate,
  isNewerVersion,
} from "./ast-index/binary-manager.js";
import { loadConfig } from "./config/loader.js";
import { isDangerousRoot } from "./core/validation.js";
import type { HookMode } from "./types.js";
import { runSummaryPipeline } from "./hooks/summary-pipeline.js";
import { formatDenyMessage } from "./hooks/format-deny-message.js";
import { isPathWithinProject } from "./hooks/path-safety.js";
import { handleSessionStart } from "./hooks/session-start.js";
import { computeEffectiveThreshold } from "./hooks/adaptive-threshold.js";
import { loadSessionSavedTokens } from "./core/session-savings.js";
import { handleSaveDocCli, handleListDocsCli } from "./cli/save-doc.js";
import { checkForTypo } from "./cli/typo-guard.js";
import { processPostTask } from "./hooks/post-task.js";
import { isContextModeInstalledSync } from "./integration/context-mode-detector.js";
import { handleBlessAgents } from "./cli/bless-agents.js";
import { unblessAgents } from "./cli/unbless-agents.js";
import { detectDrift, formatDriftFinding } from "./cli/doctor-drift.js";
import {
  handleInstallAgents,
  maybeEmitStartupReminder,
} from "./cli/install-agents.js";
import { handleUninstallAgents } from "./cli/uninstall-agents.js";
import {
  appendEvent,
  applyRetention,
  type HookEvent,
} from "./core/event-log.js";
import { handleStats } from "./cli/stats.js";
import { handleToolAudit } from "./cli/tool-audit.js";
import { promptYesNo } from "./cli/install-agents.js";
import { runClaudeCodeEnvCheck } from "./cli/doctor-env-check.js";
import {
  claudeIgnoreStatus,
  writeDefaultClaudeIgnore,
} from "./cli/claudeignore.js";
import { assessClaudeMd } from "./cli/claudemd-hygiene.js";
import {
  decidePostBashAdvice,
  renderPostBashHookOutput,
} from "./hooks/post-bash.js";
import { decidePreBash, renderPreBashOutput } from "./hooks/pre-bash.js";
import { decidePreGrep, renderPreGrepOutput } from "./hooks/pre-grep.js";
import { decidePreTask, renderPreTaskOutput } from "./hooks/pre-task.js";
import { getAgentIndex } from "./hooks/post-task.js";
import {
  decidePreEdit,
  renderPreEditOutput,
  type PreEditInput,
} from "./hooks/pre-edit.js";
import { isEditPrepared as isEditPreparedFn } from "./core/edit-prep-state.js";
import { maybeEmitEcosystemReminder } from "./cli/ecosystem-reminder.js";
import { parseEnforcementMode } from "./server/enforcement-mode.js";

const execFileAsync = promisify(execFile);

export const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "cs",
  "cpp",
  "cc",
  "cxx",
  "hpp",
  "c",
  "h",
  "php",
  "rb",
  "scala",
  "dart",
  "lua",
  "sh",
  "bash",
  "sql",
  "r",
  "vue",
  "svelte",
  "pl",
  "pm",
  "ex",
  "exs",
  "groovy",
  "m",
  "proto",
  "bsl",
  "lisp",
  "lsp",
  "cl",
  "asd",
]);

export function getVersion(): string {
  try {
    const pkgPath = new URL("../package.json", import.meta.url).pathname;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

export async function main(cliArgs = process.argv.slice(2)): Promise<void> {
  // Guard against mis-typed commands like `install-aents` silently
  // becoming a projectRoot=install-aents server launch. See TP-v0.22.3.
  const typo = checkForTypo(cliArgs[0]);
  if (typo.kind === "typo") {
    process.stderr.write(`[token-pilot] ${typo.message}\n`);
    process.exit(1);
  }

  switch (cliArgs[0]) {
    case "hook-read": {
      // v0.34.0 — wrap in runHookEntryPoint so any unexpected throw
      // lands in `~/.token-pilot/hook-errors.jsonl` instead of being
      // swallowed silently. handleHookRead has its own internal
      // try/catch for known I/O failures; the wrapper is the safety
      // net for everything else.
      await runHookEntryPoint({ hook: "hook-read" }, async () => {
        const cfg = await loadConfig(process.cwd());
        await handleHookRead(
          cliArgs[1],
          cfg.hooks.mode,
          cfg.hooks.denyThreshold,
          process.cwd(),
          {
            adaptiveThreshold: cfg.hooks.adaptiveThreshold,
            adaptiveBudgetTokens: cfg.hooks.adaptiveBudgetTokens,
          },
        );
      });
      return;
    }
    case "hook-edit":
      await runHookEntryPoint({ hook: "hook-edit" }, async () => {
        handleHookEdit();
      });
      return;
    case "hook-post-bash": {
      await runHookEntryPoint({ hook: "hook-post-bash" }, async () => {
        const stdin = readFileSync(0, "utf-8");
        const input = JSON.parse(stdin);
        const advice = decidePostBashAdvice(input, {
          contextModeAvailable: isContextModeInstalledSync(process.cwd()),
        });
        const rendered = renderPostBashHookOutput(advice);
        if (rendered) process.stdout.write(rendered);
      });
      return;
    }
    case "hook-pre-bash": {
      // v0.28.0 — passive pre-intercept for heavy Bash commands.
      // v0.34.0 — runHookEntryPoint covers throw paths.
      await runHookEntryPoint({ hook: "hook-pre-bash" }, async () => {
        const stdin = readFileSync(0, "utf-8");
        const input = JSON.parse(stdin);
        const decision = decidePreBash(
          input,
          parseEnforcementMode(process.env.TOKEN_PILOT_MODE),
        );
        const rendered = renderPreBashOutput(decision);
        if (rendered) process.stdout.write(rendered);
      });
      return;
    }
    case "hook-pre-grep": {
      // v0.28.0 — passive pre-intercept for symbol-like Grep patterns.
      // v0.34.0 — runHookEntryPoint covers throw paths.
      await runHookEntryPoint({ hook: "hook-pre-grep" }, async () => {
        const stdin = readFileSync(0, "utf-8");
        const input = JSON.parse(stdin);
        const decision = decidePreGrep(
          input,
          parseEnforcementMode(process.env.TOKEN_PILOT_MODE),
        );
        const rendered = renderPreGrepOutput(decision);
        if (rendered) process.stdout.write(rendered);
      });
      return;
    }
    case "hook-pre-task": {
      // v0.31.0 Pack 2 — route general-purpose Task dispatches to a
      // `tp-*` specialist when the description clearly matches.
      // v0.34.0 — error/diagnostic logging via runHookEntryPoint.
      await runHookEntryPoint(
        { hook: "hook-pre-task" },
        async () => {
          const stdin = readFileSync(0, "utf-8");
          const input = JSON.parse(stdin);
          const agentIndex = await getAgentIndex();
          const force = process.env.TOKEN_PILOT_FORCE_SUBAGENTS === "1";

          // v0.34.0 diagnostic: B4 — empty index + force is a fail
          // case (we deny, but record so the user can see why).
          if (force && agentIndex.agents.length === 0) {
            await appendDiagnostic(process.cwd(), {
              code: "force_subagents_no_agents",
              level: "warn",
              detail: { hint: "run `npx token-pilot install-agents`" },
            });
          }

          const decision = decidePreTask(input, {
            mode: parseEnforcementMode(process.env.TOKEN_PILOT_MODE),
            agentIndex,
            force,
          });

          // v0.34.2 — emit a diagnostic for every non-allow Task decision
          // so we can count miss-rate and pair-popularity without waiting
          // for PostToolUse:Task to land. If the post-task hook ever fails
          // again (see typo-guard bug from v0.33.1), pre-task diagnostics
          // are still recoverable from hook-events.jsonl. Best-effort —
          // never blocks the dispatch decision.
          if (decision.kind !== "allow") {
            const subagentType = input?.tool_input?.subagent_type ?? "";
            appendDiagnostic(process.cwd(), {
              code: "task_pre_intercept",
              level: decision.kind === "deny" ? "warn" : "info",
              detail: {
                decision: decision.kind,
                subagent_type:
                  typeof subagentType === "string" ? subagentType : "",
                index_size: agentIndex.agents.length,
                force,
                mode: parseEnforcementMode(process.env.TOKEN_PILOT_MODE),
              },
            }).catch(() => {
              /* never block dispatch on telemetry */
            });
          }

          // v0.38.0 — fleet budget guard. When a workflow is active and
          // its token ceiling is within reach, append a wind-down note
          // to whatever the routing decision produced. The dispatch is
          // never hard-blocked on budget (a half-finished fan-out is
          // worse than a small overrun) — we advise, and surface an
          // over-budget diagnostic so `workflow status` reflects it.
          const { activeWorkflowId, workflowStatus, isWorkflowNearBudget } =
            await import("./core/workflow.js");
          const wfId = activeWorkflowId();
          let budgetNote = "";
          if (wfId) {
            const st = await workflowStatus(process.cwd(), wfId);
            if (st && isWorkflowNearBudget(st)) {
              budgetNote =
                `\n\n[token-pilot] workflow ${wfId} is at ${st.pct ?? "~"}% of its ` +
                `${st.budget_tokens} token ceiling — finish in-flight work and ` +
                `report rather than starting new branches.`;
              appendDiagnostic(process.cwd(), {
                code: "workflow_near_budget",
                level: "warn",
                detail: { workflow_id: wfId, pct: st.pct, used: st.used_tokens },
              }).catch(() => {});
            }
          }

          const rendered = renderPreTaskOutput(decision, budgetNote);
          if (rendered) process.stdout.write(rendered);
        },
      );
      return;
    }
    case "hook-post-task": {
      await runHookEntryPoint({ hook: "hook-post-task" }, async () => {
        const stdin = readFileSync(0, "utf-8");
        const input = JSON.parse(stdin);
        const message = await processPostTask(process.cwd(), homedir(), input);
        if (message) {
          process.stdout.write(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PostToolUse",
                additionalContext: `[token-pilot] ${message}`,
              },
            }),
          );
        }
      });
      return;
    }
    case "hook-bootstrap": {
      // v0.35.0 — fires ONCE per project via Claude Code's undocumented
      // `once: true` SessionStart flag. Self-removes after the first
      // run, so steps must be idempotent (re-running cannot hurt).
      // Stays silent on success; only emits hints when something is
      // missing. Always exits 0 — the very first session must never
      // be blocked by a bootstrap hint.
      await runHookEntryPoint({ hook: "hook-bootstrap" }, async () => {
        const cwd = process.cwd();
        const hints = [];
        // Detect installed tp-* agents (project-level OR user-level).
        try {
          const { readdirSync, existsSync } = await import("node:fs");
          const projAgents = resolve(cwd, ".claude", "agents");
          const userAgents = resolve(homedir(), ".claude", "agents");
          let total = 0;
          for (const dir of [projAgents, userAgents]) {
            if (existsSync(dir)) {
              total += readdirSync(dir).filter(
                (f) => f.startsWith("tp-") && f.endsWith(".md"),
              ).length;
            }
          }
          if (total === 0) {
            hints.push(
              "no tp-* agents installed — run `npx token-pilot install-agents --scope=project` to enable the 25-agent toolkit",
            );
          }
        } catch {
          /* skip silently */
        }
        // Detect ast-index binary availability.
        try {
          const { findBinary } = await import("./ast-index/binary-manager.js");
          const status = await findBinary();
          if (!status.available) {
            hints.push(
              "ast-index binary missing — run `npx token-pilot install-ast-index` to unlock find_usages / outline / read_symbol",
            );
          }
        } catch {
          /* skip silently */
        }
        if (hints.length > 0) {
          const message = `[token-pilot] bootstrap notes:\n  - ${hints.join("\n  - ")}`;
          process.stdout.write(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "SessionStart",
                additionalContext: message,
              },
            }),
          );
        }
      });
      return;
    }
    case "hook-subagent-stop": {
      // v0.40.0 — canonical subagent-completion capture. PostToolUse:Task
      // proved non-firing for the dispatch tool (clean v0.39.3 probe:
      // a real dispatch wrote 0 events while a Read-deny in the same
      // session wrote fine). SubagentStop fires once per subagent by
      // definition, so this is the reliable source for the task
      // adoption signal. Synchronous (writes telemetry — never async).
      await runHookEntryPoint({ hook: "hook-subagent-stop" }, async () => {
        const stdin = readFileSync(0, "utf-8");
        const input = JSON.parse(stdin);
        const {
          buildSubagentTaskEvent,
          decideSubagentFeedback,
          renderSubagentFeedback,
        } = await import("./hooks/subagent-stop.js");
        const ev = buildSubagentTaskEvent(input, Date.now());
        if (ev) {
          const { appendEvent } = await import("./core/event-log.js");
          await appendEvent(process.cwd(), ev);
        }

        // v0.41.0 — optional SubagentStop feedback. Returning
        // hookSpecificOutput.additionalContext from SubagentStop is a
        // Claude Code 2.1.163+ feature; on older Claude Code it is
        // labelled a hook error (noise). Gate strictly behind
        // TOKEN_PILOT_SUBAGENT_FEEDBACK=1 so the default path (telemetry
        // only) stays safe on every version.
        if (process.env.TOKEN_PILOT_SUBAGENT_FEEDBACK === "1") {
          const { activeWorkflowId, workflowStatus } = await import(
            "./core/workflow.js"
          );
          let wf = null;
          const wfId = activeWorkflowId();
          if (wfId) {
            const st = await workflowStatus(process.cwd(), wfId);
            if (st) {
              wf = {
                workflow_id: st.workflow_id,
                budget_tokens: st.budget_tokens,
                used_tokens: st.used_tokens,
                pct: st.pct,
              };
            }
          }
          const rendered = renderSubagentFeedback(
            decideSubagentFeedback(input, { workflow: wf }),
          );
          if (rendered) process.stdout.write(rendered);
        }
      });
      return;
    }
    case "hook-session-start": {
      await runHookEntryPoint({ hook: "hook-session-start" }, async () => {
        const cfg = await loadConfig(process.cwd());
        // sessionStart.enabled is independent of hooks.mode by design.
        if (!cfg.sessionStart.enabled) return;
        const result = await handleSessionStart({
          projectRoot: process.cwd(),
          homeDir: homedir(),
          sessionStartConfig: cfg.sessionStart,
        });
        if (result) {
          process.stdout.write(result);
        }
      });
      return;
    }
    case "install-hook":
      await handleInstallHook(cliArgs[1] || process.cwd());
      return;
    case "uninstall-hook":
      await handleUninstallHook(cliArgs[1] || process.cwd());
      return;
    case "errors": {
      // v0.34.0 — surface ~/.token-pilot/hook-errors.jsonl with optional
      // filters: --tail=N --code=<x> --hook=<y> --level=<info|warn|error>
      const args = cliArgs.slice(1);
      const flag = (k: string) => {
        for (const a of args) {
          if (a.startsWith(`--${k}=`)) return a.slice(k.length + 3);
          if (a === `--${k}` || a === `-${k}`) return "true";
        }
        return undefined;
      };
      const tailRaw = flag("tail");
      const records = await loadErrors({
        tail: tailRaw ? Number(tailRaw) : undefined,
        code: flag("code"),
        hook: flag("hook"),
        level: flag("level") as "info" | "warn" | "error" | undefined,
      });
      process.stdout.write(formatErrorList(records) + "\n");
      return;
    }
    case "workflow": {
      // v0.38.0 — fleet workflow lifecycle. token-pilot owns the
      // workflow boundary (we set TOKEN_PILOT_WORKFLOW_ID ourselves),
      // so this works regardless of whether Claude Code's /workflow
      // propagates an env var. Subcommands: start / end / status / list.
      const code = await handleWorkflowCli(cliArgs.slice(1));
      process.exit(code);
      return;
    }
    case "migrate-hooks": {
      // v0.33.0 — clean stale npx-cache / pinned-version token-pilot
      // hook entries from user-level + project-level settings.json so
      // the bundled plugin's hooks/hooks.json takes over via
      // CLAUDE_PLUGIN_ROOT. Safe and idempotent.
      const targets = [
        resolve(homedir(), ".claude", "settings.json"),
        resolve(cliArgs[1] || process.cwd(), ".claude", "settings.json"),
      ];
      let total = 0;
      for (const path of targets) {
        const r = await cleanStaleHookEntries(path);
        console.log(r.message);
        total += r.staleEntriesRemoved;
      }
      console.log(`\nDone — removed ${total} stale entr${total === 1 ? "y" : "ies"}.`);
      return;
    }
    case "install-ast-index":
      await handleInstallAstIndex();
      return;
    case "doctor":
      await handleDoctor();
      return;
    case "bless-agents":
      await handleBlessAgents(cliArgs.slice(1));
      return;
    case "unbless-agents": {
      const args = cliArgs.slice(1);
      const all = args.includes("--all");
      const names = args.filter((a) => !a.startsWith("--"));
      if (!all && names.length === 0) {
        process.stderr.write(
          "Usage: token-pilot unbless-agents <name>... | --all\n",
        );
        process.exit(1);
      }
      await unblessAgents({ projectRoot: process.cwd(), names, all });
      return;
    }
    case "install-agents": {
      const code = await handleInstallAgents(cliArgs.slice(1));
      process.exit(code);
      return;
    }
    case "uninstall-agents": {
      const code = await handleUninstallAgents(cliArgs.slice(1));
      process.exit(code);
      return;
    }
    case "stats": {
      const code = await handleStats(cliArgs.slice(1));
      process.exit(code);
      return;
    }
    case "tool-audit": {
      const code = await handleToolAudit(cliArgs.slice(1));
      process.exit(code);
      return;
    }
    case "save-doc": {
      const code = await handleSaveDocCli(cliArgs.slice(1));
      process.exit(code);
      return;
    }
    case "list-docs": {
      const code = await handleListDocsCli();
      process.exit(code);
      return;
    }
    case "init":
      await handleInit(cliArgs[1] || process.cwd());
      return;
    case "--version":
    case "-v":
      console.log(getVersion());
      process.exit(0);
      return;
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      await startServer(cliArgs);
      return;
  }
}

/**
 * Defensive check for the Claude Code plugin `start.sh` bug (fixed 2026-04-24,
 * but older installs still in the wild). If the caller passed the plugin's own
 * cache dir as projectRoot, every relative path like `front/src/File.php` gets
 * resolved inside the plugin install instead of the user's repo (ENOENT).
 *
 * Matches the canonical Claude Code plugin cache pattern
 *   ~/.claude/plugins/cache/token-pilot/token-pilot/<version>/
 * on both POSIX and Windows separators. Intentionally narrow — does NOT match
 * dev installs (cloning the repo and running against itself stays legal).
 */
export function looksLikePluginCacheDir(candidate: string): boolean {
  if (!candidate) return false;
  try {
    const resolved = resolve(candidate);
    return /[\\/]plugins[\\/]cache[\\/]token-pilot[\\/]/.test(resolved);
  } catch {
    return false;
  }
}

/**
 * v0.33.0 (B8) — reject candidates that are obviously not a project
 * directory. Triggered by WSL launches where the shell starts in
 * `C:\Windows\System32`, `/mnt/c/Windows/...`, or a UNC path. Without
 * this guard, `git rev-parse --show-toplevel` either fails noisily or
 * returns the Windows tree, leaving every subsequent git/MCP call
 * looking at the wrong filesystem.
 *
 * Conservative — only matches paths we are certain are not user code.
 */
export function isWindowsSystemPath(candidate: string): boolean {
  if (!candidate) return false;
  // Native Windows: C:\Windows\... or C:/Windows/...
  if (/^[A-Za-z]:[\\/](Windows|Program Files|ProgramData)\b/i.test(candidate)) {
    return true;
  }
  // WSL view of Windows: /mnt/c/Windows/... (or any drive letter)
  if (/^\/mnt\/[a-z]\/(windows|program files|programdata)\b/i.test(candidate)) {
    return true;
  }
  // UNC path — almost never a project root and `cwd` cannot be set to
  // one reliably anyway. Better to skip than to misroute.
  if (/^\\\\/.test(candidate)) {
    return true;
  }
  return false;
}

export async function startServer(cliArgs: string[] = process.argv.slice(2)) {
  // Defensive: ignore a poisoned cliArgs[0] pointing into the plugin install
  // dir. Fall through to the INIT_CWD / PWD / cwd detection below — same
  // behaviour as if the argument had never been passed.
  let explicitRoot = cliArgs[0];
  if (explicitRoot && looksLikePluginCacheDir(explicitRoot)) {
    console.error(
      `[token-pilot] ignoring "${explicitRoot}" — looks like the plugin cache dir (start.sh bug). Auto-detecting project root instead.`,
    );
    explicitRoot = "";
  }

  let projectRoot = explicitRoot || process.cwd();

  // Detect git root for reliable project root.
  // v0.33.0 (B8) — on WSL the shell is sometimes launched with the
  // working directory pointing into Windows' filesystem
  // (`/mnt/c/Windows/system32` or, worse, a UNC like `\\\\wsl$\\…`).
  // INIT_CWD/PWD/cwd then resolve to a Windows system path and
  // every git operation lands in the wrong tree. Claude Code itself
  // reliably exports `CLAUDE_PROJECT_DIR` — prefer it absolutely
  // when present and reject obvious system paths regardless.
  if (!explicitRoot) {
    const rawCandidates = [
      process.env.CLAUDE_PROJECT_DIR, // canonical Claude Code env (B8)
      process.env.INIT_CWD, // npm/npx sets this to invoking directory
      process.env.PWD, // shell working directory (may differ from cwd)
      process.cwd(), // Node.js working directory
    ].filter((c): c is string => !!c && c !== "/");
    // v0.34.0 — emit a diagnostic for every Windows / UNC reject so
    // we can see in stats how often WSL launches misroute the cwd.
    for (const c of rawCandidates) {
      if (isWindowsSystemPath(c)) {
        try {
          await appendDiagnostic(process.cwd(), {
            code: "wsl_path_rejected",
            level: "warn",
            detail: { path_basename: c.split(/[\\/]/).pop() ?? "" },
          });
        } catch {
          /* logger of last resort */
        }
      }
    }
    const candidates = rawCandidates.filter((c) => !isWindowsSystemPath(c));

    let detected = false;
    for (const candidate of candidates) {
      if (isDangerousRoot(candidate)) continue;
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["rev-parse", "--show-toplevel"],
          {
            cwd: candidate,
            timeout: 3000,
          },
        );
        const gitRoot = stdout.trim();
        if (gitRoot && !isDangerousRoot(gitRoot)) {
          projectRoot = gitRoot;
          console.error(
            `[token-pilot] project root: ${projectRoot} (git from ${candidate === process.env.INIT_CWD ? "INIT_CWD" : candidate === process.env.PWD ? "PWD" : "cwd"})`,
          );
          detected = true;
          break;
        }
      } catch {
        // Not a git repo at this candidate — try next
      }
    }

    if (!detected) {
      // Use best non-dangerous candidate as fallback even without git
      const fallback = candidates.find((c) => !isDangerousRoot(c));
      if (fallback) {
        projectRoot = fallback;
        console.error(
          `[token-pilot] project root: ${projectRoot} (${fallback === process.env.INIT_CWD ? "INIT_CWD" : "PWD"}, not a git repo)`,
        );
      } else {
        console.error(
          `[token-pilot] project root: ${projectRoot} (cwd, not a git repo)`,
        );
      }
    }
  }

  // v0.34.0 — fire-and-forget startup diagnostic so we can verify
  // in real-world telemetry whether the new Claude Code (which exposes
  // CLAUDE_PROJECT_DIR to MCP stdio servers since the May 2026 update)
  // is what actually drove the projectRoot decision. NOT awaited — an
  // extra await before createServer breaks tests that rely on a tight
  // microtask flush, and the emit is purely advisory.
  {
    const cpd = process.env.CLAUDE_PROJECT_DIR;
    appendDiagnostic(projectRoot, {
      code: "mcp_startup",
      level: "info",
      detail: {
        project_root_source: explicitRoot
          ? "args"
          : cpd && projectRoot === cpd
            ? "CLAUDE_PROJECT_DIR"
            : process.env.INIT_CWD && projectRoot === process.env.INIT_CWD
              ? "INIT_CWD"
              : "git-detect-or-cwd",
        claude_project_dir_present: !!cpd,
        platform: process.platform,
      },
    }).catch(() => {
      /* best-effort */
    });
  }

  // Guard: refuse to use dangerous roots that would index the entire disk
  if (isDangerousRoot(projectRoot)) {
    console.error(
      `[token-pilot] WARNING: project root "${projectRoot}" is too broad (system/home directory).\n` +
        `  ast-index will be disabled to prevent indexing the entire filesystem.\n` +
        `  Fix: pass project path explicitly — token-pilot /path/to/project\n` +
        `  Or configure mcpServers with "args": ["/path/to/project"]`,
    );
  }

  // Non-blocking update check for all components (logs to stderr, never blocks startup)
  const config = await loadConfig(projectRoot);
  const binaryStatus = await findBinary(config.astIndex.binaryPath);
  checkAllUpdates(config, binaryStatus).catch(() => {
    /* ignore */
  });

  // Phase 5 subtask 5.6 — one-time reminder when no tp-* agents installed.
  // Non-blocking, silent on error, single-fire per process.
  maybeEmitStartupReminder({
    projectRoot,
    homeDir: homedir(),
    configSuppressed: config.agents?.reminder === false,
  }).catch(() => {
    /* ignore */
  });

  // v0.30.x ecosystem nudge — one-time stderr tip suggesting caveman for
  // output compression. Fires at most once per MCP process, stays silent
  // when caveman is already detected or TOKEN_PILOT_NO_ECOSYSTEM_TIPS=1.
  // Static import + synchronous call so nothing ever blocks startServer.
  try {
    maybeEmitEcosystemReminder();
  } catch {
    /* ecosystem reminder must never block startup */
  }

  // Phase 6 subtask 6.2 — age + size retention on hook-events archives.
  // Fire-and-forget: retention failures must never block startup.
  applyRetention(projectRoot).catch(() => {
    /* ignore */
  });

  // Auto-install PreToolUse hook (non-blocking, Claude Code only)
  // Uses absolute paths to node + script so hooks work in /bin/sh (nvm, npx, etc.)
  let hookOptions: { scriptPath?: string; nodeExecPath?: string } | undefined;
  try {
    const rawPath = fileURLToPath(new URL("./index.js", import.meta.url));
    hookOptions = {
      scriptPath: realpathSync(rawPath),
      nodeExecPath: process.execPath,
    };
  } catch {
    // Can't resolve script path (e.g. running from src/ in tests) — fall back to bare command
  }
  installHook(projectRoot, hookOptions)
    .then((result) => {
      if (result.installed) {
        console.error(`[token-pilot] hook auto-installed: ${result.message}`);
      }
    })
    .catch(() => {
      /* ignore — not Claude Code or no .claude dir */
    });

  const server = await createServer(projectRoot, {
    skipAstIndex: isDangerousRoot(projectRoot),
    enforcementMode: parseEnforcementMode(process.env.TOKEN_PILOT_MODE),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await server.close();
    process.exit(0);
  });
}

export interface HookReadAdaptiveOptions {
  adaptiveThreshold?: boolean;
  adaptiveBudgetTokens?: number;
}

export async function handleHookRead(
  filePathArg?: string,
  mode: HookMode = "deny-enhanced",
  denyThreshold = 300,
  projectRoot: string = process.cwd(),
  adaptive: HookReadAdaptiveOptions = {},
): Promise<void> {
  // Mode 'off' — hook is inert regardless of input.
  if (mode === "off") {
    process.exit(0);
  }

  const dispatchResult = await runHookReadDispatch(
    filePathArg,
    mode,
    denyThreshold,
    projectRoot,
    adaptive,
  );
  if (dispatchResult) {
    process.stdout.write(dispatchResult);
  }
  process.exit(0);
}

/**
 * Pure implementation of the hook-read dispatch — returns the JSON payload
 * to write to stdout, or null when we should pass-through (no output).
 * Extracted for testability; the outer handleHookRead adds the process.exit
 * wrapping.
 */
export async function runHookReadDispatch(
  filePathArg: string | undefined,
  mode: HookMode,
  denyThresholdArg?: number,
  projectRootArg?: string,
  adaptive: HookReadAdaptiveOptions = {},
): Promise<string | null> {
  const denyThreshold = denyThresholdArg ?? 300;
  const projectRoot = projectRootArg ?? process.cwd();
  return runHookReadDispatchImpl(
    filePathArg,
    mode,
    denyThreshold,
    projectRoot,
    adaptive,
  );
}

async function runHookReadDispatchImpl(
  filePathArg: string | undefined,
  mode: HookMode,
  denyThreshold: number,
  projectRoot: string,
  adaptive: HookReadAdaptiveOptions = {},
): Promise<string | null> {
  if (mode === "off") return null;

  // Parse stdin to get tool_input + session/agent metadata, unless a
  // filePath was supplied directly (tests, --filePath invocation).
  let filePath = filePathArg;
  let hasOffset = false;
  let hasLimit = false;
  let sessionId: string = "";
  let agentType: string | null = null;
  let agentId: string | null = null;

  if (!filePath) {
    try {
      const stdin = readFileSync(0, "utf-8");
      const input = JSON.parse(stdin);
      filePath = input?.tool_input?.file_path;
      hasOffset = input?.tool_input?.offset != null;
      hasLimit = input?.tool_input?.limit != null;
      sessionId = typeof input?.session_id === "string" ? input.session_id : "";
      agentType =
        typeof input?.agent_type === "string" ? input.agent_type : null;
      agentId = typeof input?.agent_id === "string" ? input.agent_id : null;
    } catch {
      return null;
    }
  }

  if (!filePath) return null;

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (!CODE_EXTENSIONS.has(ext)) return null;

  // Bounded Reads are always passed through — the agent already narrowed scope.
  if (hasOffset || hasLimit) return null;

  // Path safety: refuse to summarise any file outside the project root
  // (traversal, symlinks pointing outside). Pass-through on failure so the
  // agent is never blocked by a safety reject.
  if (!isPathWithinProject(filePath, projectRoot)) {
    try {
      process.stderr.write(
        `[token-pilot] refusing to summarise "${filePath}" — outside project root. Hook passing through.\n`,
      );
    } catch {
      /* silent — hook must not break */
    }
    return null;
  }

  // Resolve effective threshold once (cheap if adaptive is off).
  const effectiveThreshold = adaptive.adaptiveThreshold
    ? computeEffectiveThreshold({
        baseThreshold: denyThreshold,
        sessionSavedTokens: loadSessionSavedTokens(projectRoot, sessionId),
        sessionBudgetTokens: adaptive.adaptiveBudgetTokens ?? 100_000,
        enabled: true,
      })
    : denyThreshold;

  // Read file content + line count.
  let fileContent = "";
  let lineCount = 0;
  try {
    fileContent = readFileSync(filePath, "utf-8");
    lineCount = fileContent.split("\n").length;
    if (lineCount <= effectiveThreshold) return null;
  } catch {
    return null;
  }

  const charEst = Math.ceil(fileContent.length / 4);
  const wsRatio = (fileContent.match(/\s/g)?.length ?? 0) / fileContent.length;
  const estTokens = Math.ceil(charEst * (1 - wsRatio * 0.3));

  // Legacy telemetry (hook-denied.jsonl) — retained for backward compatibility
  // with existing loadDeniedReads() readers in session-analytics. Never block
  // hook dispatch on failure.
  try {
    const entry = JSON.stringify({
      filePath,
      lineCount,
      estimatedTokens: estTokens,
      mode,
      timestamp: Date.now(),
    });
    const dir = join(projectRoot, ".token-pilot");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "hook-denied.jsonl"), entry + "\n");
  } catch {
    /* silent — hook must not break */
  }

  const writeEvent = async (
    eventKind: HookEvent["event"],
    summaryTokens: number,
  ): Promise<void> => {
    await appendEvent(projectRoot, {
      ts: Date.now(),
      session_id: sessionId,
      agent_type: agentType,
      agent_id: agentId,
      event: eventKind,
      file: filePath!,
      lines: lineCount,
      estTokens,
      summaryTokens,
      savedTokens: Math.max(0, estTokens - summaryTokens),
    });
  };

  if (mode === "advisory") {
    const reason =
      `File "${filePath}" has ${lineCount} lines. Use mcp__token-pilot__smart_read("${filePath}") ` +
      `for a structural overview, or mcp__token-pilot__read_for_edit("${filePath}", symbol="<name>") ` +
      `for edit context. Bounded Read with offset/limit is still allowed.`;
    await writeEvent("denied", Math.ceil(reason.length / 4));
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    });
  }

  // mode === 'deny-enhanced'
  const pipelineResult = await runSummaryPipeline(fileContent, filePath);
  if (pipelineResult.kind === "pass-through") {
    await writeEvent("pass-through", 0);
    return null;
  }

  const message = formatDenyMessage({
    filePath,
    summary: pipelineResult.summary,
    tier: pipelineResult.tier,
  });
  await writeEvent("denied", Math.ceil(message.length / 4));

  // v0.35.0 — `updatedInput` rewrite. Claude Code's undocumented
  // PreToolUse return key (surfaced from @anthropic-ai/claude-code@2.1.87
  // source) lets a hook silently transform the tool_input instead of
  // blocking. When TOKEN_PILOT_HOOK_REWRITE=1 is set we bound the Read
  // to its first ~200 lines so the model sees a truncated file rather
  // than a deny + suggestion. The structural summary still rides in
  // `additionalContext`, so the model gets both views in one round.
  //
  // Default OFF — the field is undocumented and changes user-visible
  // behaviour. Opt-in only.
  if (process.env.TOKEN_PILOT_HOOK_REWRITE === "1") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: {
          file_path: filePath,
          offset: 1,
          limit: 200,
        },
        additionalContext:
          `[token-pilot] Read on ${filePath} was rewritten to lines 1-200 ` +
          `(file has ${lineCount} lines). For full structure use mcp__token-pilot__smart_read(${filePath}).\n\n` +
          message,
      },
    });
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: message,
    },
  });
}

/**
 * PreToolUse:Edit / MultiEdit / Write enforcement.
 *
 * v0.30.0 upgraded this from a passive advisory hint into a real gate.
 * The previous implementation always returned `allow` + a TIP; Claude
 * ignored the TIP and kept building Edit's old_string from smart_read
 * snippets (tool-audit 2026-04-24: read_for_edit = 0-1% of Claude calls
 * vs 33% for Codex, which gets explicit prompt-level enforcement).
 *
 * New behaviour driven by TOKEN_PILOT_MODE:
 *   - advisory → allow + non-blocking hint when the file wasn't prepped
 *   - deny     → block when the file wasn't prepped (the default)
 *   - strict   → same as deny, plus event log for telemetry
 *
 * Pure decision logic lives in src/hooks/pre-edit.ts — this wrapper is
 * responsible only for stdin parsing and I/O-bound context resolution
 * (file existence, prep-state lookup, env vars).
 */
export function handleHookEdit() {
  let input: PreEditInput;
  try {
    const stdin = readFileSync(0, "utf-8");
    input = JSON.parse(stdin);
  } catch {
    process.exit(0);
  }

  const filePath = input.tool_input?.file_path;
  if (typeof filePath !== "string" || filePath.length === 0) {
    process.exit(0);
  }

  const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const isCodeFile = CODE_EXTENSIONS.has(ext);
  const mode = parseEnforcementMode(process.env.TOKEN_PILOT_MODE);
  const bypassed = process.env.TOKEN_PILOT_BYPASS === "1";

  // Existence check must be sync + cheap — the hook is on the request hot path.
  let fileExists = false;
  try {
    fileExists = existsSync(filePath);
  } catch {
    // If we can't even stat it, fall back to "does not exist" so Write-on-new
    // still flows through; Edit on a missing file would error anyway.
    fileExists = false;
  }

  const isPrepared = isCodeFile
    ? isEditPreparedFn(projectRoot, filePath)
    : false;

  const decision = decidePreEdit(input, {
    mode,
    isCodeFile,
    fileExists,
    isPrepared,
    bypassed,
  });

  const rendered = renderPreEditOutput(decision);
  if (rendered) process.stdout.write(rendered);
  process.exit(0);
}

/**
 * v0.38.0 — `token-pilot workflow <subcommand>` CLI.
 *
 *   start <goal> [--budget=N] [--max-parallel=N]
 *       Create a workflow envelope and print an `export
 *       TOKEN_PILOT_WORKFLOW_ID=<id>` line. Wrap a fan-out batch with
 *       this so every hook event gets tagged with the id.
 *   end [<id>]      Stamp the workflow ended (defaults to active env id).
 *   status [<id>]   Show live budget + task counts (defaults to env id).
 *   list            All recorded workflows, newest first.
 *
 * Returns a process exit code.
 */
export async function handleWorkflowCli(argv: string[]): Promise<number> {
  const projectRoot = process.cwd();
  const sub = argv[0];
  const flag = (k: string): string | undefined => {
    for (const a of argv) {
      if (a.startsWith(`--${k}=`)) return a.slice(k.length + 3);
    }
    return undefined;
  };
  const envId =
    process.env.TOKEN_PILOT_WORKFLOW_ID ||
    process.env.CLAUDE_CODE_WORKFLOW_ID ||
    undefined;

  switch (sub) {
    case "start": {
      const goal = argv.slice(1).filter((a) => !a.startsWith("--")).join(" ");
      if (!goal) {
        process.stderr.write(
          'workflow start: a goal is required — `token-pilot workflow start "review last sprint"`\n',
        );
        return 1;
      }
      const budgetRaw = flag("budget");
      const parallelRaw = flag("max-parallel");
      const env = await startWorkflow({
        projectRoot,
        goal,
        budgetTokens: budgetRaw ? Number(budgetRaw) : null,
        maxParallel: parallelRaw ? Number(parallelRaw) : null,
      });
      // The id goes to stdout as an `export` line so a user can do
      //   eval "$(token-pilot workflow start '...')"
      // and have the env var set for the fan-out that follows.
      process.stdout.write(`export TOKEN_PILOT_WORKFLOW_ID=${env.workflow_id}\n`);
      process.stderr.write(
        `[token-pilot] workflow ${env.workflow_id} started` +
          (env.budget_tokens ? ` · ${env.budget_tokens} token ceiling` : "") +
          `\n`,
      );
      return 0;
    }
    case "end": {
      const id = argv[1] && !argv[1].startsWith("--") ? argv[1] : envId;
      if (!id) {
        process.stderr.write(
          "workflow end: no id given and TOKEN_PILOT_WORKFLOW_ID not set.\n",
        );
        return 1;
      }
      const env = await endWorkflow(projectRoot, id);
      if (!env) {
        process.stderr.write(`workflow end: unknown workflow "${id}".\n`);
        return 1;
      }
      const status = await workflowStatus(projectRoot, id);
      if (status) process.stdout.write(formatWorkflowStatus(status) + "\n");
      process.stderr.write(`[token-pilot] workflow ${id} ended.\n`);
      return 0;
    }
    case "status": {
      const id = argv[1] && !argv[1].startsWith("--") ? argv[1] : envId;
      if (!id) {
        process.stderr.write(
          "workflow status: no id given and TOKEN_PILOT_WORKFLOW_ID not set.\n",
        );
        return 1;
      }
      const status = await workflowStatus(projectRoot, id);
      if (!status) {
        process.stderr.write(`workflow status: unknown workflow "${id}".\n`);
        return 1;
      }
      process.stdout.write(formatWorkflowStatus(status) + "\n");
      return 0;
    }
    case "list": {
      const workflows = await listWorkflows(projectRoot);
      process.stdout.write(formatWorkflowList(workflows) + "\n");
      return 0;
    }
    default:
      process.stderr.write(
        "Usage: token-pilot workflow <start|end|status|list>\n" +
          '  start "<goal>" [--budget=N] [--max-parallel=N]\n' +
          "  end [<id>]\n" +
          "  status [<id>]\n" +
          "  list\n",
      );
      return sub ? 1 : 0;
  }
}

export async function handleInstallHook(projectRoot: string) {
  // v0.26.5 — plugin-aware early-return. If we're running as a Claude
  // Code plugin (CLAUDE_PLUGIN_ROOT set) the hooks are already declared
  // in hooks/hooks.json and Claude Code wires them up
  // on install. Calling install-hook in that context would write a
  // duplicate entry to the user's settings.json and emit two hooks for
  // every event. Bail early.
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    console.log(
      "token-pilot is running as a Claude Code plugin — hooks are already\n" +
        "declared in hooks/hooks.json and registered by the\n" +
        "plugin installer. `install-hook` is only needed for npm/npx setups.\n" +
        "Skipping to avoid duplicate hook entries.",
    );
    process.exit(0);
  }

  // v0.33.0 — detect when the user already enabled the token-pilot
  // plugin in `~/.claude/settings.json`. Even though we're running
  // outside CLAUDE_PLUGIN_ROOT here (CLI invocation), the plugin's
  // own `hooks/hooks.json` is what Claude Code uses at runtime.
  // Writing additional entries with a captured npx-cache path leads
  // to the bug B2 (v0.33.0): hooks pinned to an old binary that
  // never sees newer hook handlers. Surface a clear migration step
  // instead of silently duplicating.
  if (await isTokenPilotPluginEnabled(homedir())) {
    const userSettings = resolve(homedir(), ".claude", "settings.json");
    const cleanup = await cleanStaleHookEntries(userSettings);
    console.log(
      "token-pilot plugin is enabled in ~/.claude/settings.json —\n" +
        "the plugin's bundled hooks/hooks.json is the source of truth.\n" +
        "Skipping settings.json hook write to avoid pinning to a stale path.\n" +
        cleanup.message,
    );
    process.exit(0);
  }

  let hookOptions: { scriptPath?: string; nodeExecPath?: string } | undefined;
  try {
    const rawPath = fileURLToPath(new URL("./index.js", import.meta.url));
    hookOptions = {
      scriptPath: realpathSync(rawPath),
      nodeExecPath: process.execPath,
    };
  } catch {
    // Fall back to bare command
  }
  const result = await installHook(projectRoot, hookOptions);
  console.log(result.message);
  process.exit(result.fatal ? 1 : 0);
}

export async function handleUninstallHook(projectRoot: string) {
  const result = await uninstallHook(projectRoot);
  console.log(result.message);
  process.exit(result.fatal ? 1 : 0);
}

export async function handleInstallAstIndex() {
  const status = await findBinary();
  if (status.available) {
    // Check if update is available
    const update = await checkBinaryUpdate(status.path);
    if (update.updateAvailable) {
      console.log(
        `ast-index ${update.current} installed, updating to ${update.latest}...`,
      );
    } else {
      console.log(
        `ast-index ${status.version} already up to date at ${status.path} (${status.source})`,
      );
      process.exit(0);
    }
  }

  try {
    const result = await installBinary((msg) => console.log(msg));
    console.log(`\nast-index ${result.version} installed to ${result.path}`);
    process.exit(0);
  } catch (err) {
    console.error(`Failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export async function handleDoctor() {
  const version = getVersion();
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const cwd = process.cwd();

  console.log(`token-pilot doctor v${version}\n`);

  // ── Installation mode ──
  // v0.26.5 — tell the user HOW token-pilot is installed. Matters
  // because plugin users don't need `install-hook` (hooks come from
  // hooks/hooks.json); npm users do. dev/worktree users
  // are usually contributors running from a local checkout.
  let installMode: string;
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    installMode = `plugin (${process.env.CLAUDE_PLUGIN_ROOT})`;
  } else if (process.argv[1]?.includes("/.claude/worktrees/")) {
    installMode = "dev / worktree (contributor)";
  } else {
    installMode = "npm / npx";
  }
  console.log(`Install mode:   ${installMode}`);

  // ── Environment ──
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1), 10);
  console.log(
    `Node.js:        ${nodeVersion} ${nodeMajor >= 18 ? "✓" : "✗ (requires >=18)"}`,
  );

  const configPath = join(cwd, ".token-pilot.json");
  console.log(
    `config:         ${existsSync(configPath) ? configPath + " ✓" : "default (no .token-pilot.json)"}`,
  );

  const gitDir = join(cwd, ".git");
  console.log(
    `git repo:       ${existsSync(gitDir) ? "yes ✓" : "no (read_diff/git features unavailable)"}`,
  );
  console.log("");

  // ── token-pilot ──
  console.log("── token-pilot ──");
  console.log(`  installed:    ${version}`);
  const tpLatest = await checkNpmLatest("token-pilot");
  if (tpLatest) {
    if (isNewerVersion(version, tpLatest)) {
      console.log(`  latest:       ${tpLatest} (update available!)`);
      console.log(
        `  run:          npx clear-npx-cache && npx -y token-pilot@latest`,
      );
    } else {
      console.log(`  latest:       ${tpLatest} ✓ (up to date)`);
    }
  } else {
    console.log(`  latest:       could not check (network error)`);
  }
  console.log("");

  // ── ast-index ──
  console.log("── ast-index ──");
  const astStatus = await findBinary();
  if (astStatus.available) {
    console.log(
      `  installed:    ${astStatus.version} (${astStatus.source}: ${astStatus.path})`,
    );
    const astUpdate = await checkBinaryUpdate(astStatus.path);
    if (astUpdate.updateAvailable) {
      console.log(`  latest:       ${astUpdate.latest} (update available!)`);
      console.log(`  run:          npx token-pilot install-ast-index`);
    } else if (astUpdate.latest) {
      console.log(`  latest:       ${astUpdate.latest} ✓ (up to date)`);
    }

    const config = await loadConfig(cwd);
    console.log(
      `  auto-update:  ${config.updates.autoUpdate ? "enabled ✓" : "disabled (set updates.autoUpdate=true in .token-pilot.json)"}`,
    );
  } else {
    console.log(`  installed:    not found ✗`);
    console.log(`  run:          npx token-pilot install-ast-index`);
  }
  console.log("");

  // ── context-mode ──
  console.log("── context-mode ──");
  const { detectContextMode } =
    await import("./integration/context-mode-detector.js");
  const cmStatus = await detectContextMode(cwd);
  console.log(
    `  detected:     ${cmStatus.detected ? `yes (${cmStatus.source})` : "no"}`,
  );
  const cmLatest = await checkNpmLatest("claude-context-mode");
  if (cmLatest) {
    console.log(`  latest npm:   ${cmLatest}`);
  }
  if (!cmStatus.detected) {
    console.log(`  setup:        npx token-pilot init`);
  }
  console.log("");

  // ── blessed agents drift check ──
  const drift = await detectDrift({ projectRoot: cwd, homeDir: homedir() });
  if (drift.length > 0) {
    console.log("── blessed-agents drift ──");
    for (const finding of drift) {
      console.log(`  ${formatDriftFinding(finding)}`);
    }
    console.log("");
  }

  // ── Claude Code env-var savings tips ──
  try {
    const tips = await runClaudeCodeEnvCheck();
    if (tips.length > 0) {
      console.log("── Claude Code env knobs (savings tips) ──");
      for (const t of tips) {
        console.log(`  ⚠ ${t}`);
      }
      console.log("");
    }
  } catch {
    /* doctor must never crash over an optional check */
  }

  // ── .claudeignore ──
  try {
    const status = await claudeIgnoreStatus(cwd);
    console.log("── .claudeignore ──");
    if (status.kind === "absent") {
      console.log(
        `  not present — run \`npx token-pilot init\` to add sensible defaults`,
      );
    } else if (status.kind === "managed") {
      console.log(`  present ✓ (managed by token-pilot; safe to edit)`);
    } else {
      console.log(`  present ✓ (user-owned; token-pilot will not touch it)`);
    }
    console.log("");
  } catch {
    /* ignore */
  }

  // ── profile recommendation ──
  // v0.26.4 — data-driven. Reads cumulative tool-calls.jsonl and suggests
  // the narrowest TOKEN_PILOT_PROFILE that wouldn't hide any tool the
  // user actually invokes. Never auto-applies; doctor just prints the
  // env snippet and why.
  try {
    const { loadAllToolCalls } = await import("./core/tool-call-log.js");
    const { recommendProfile, formatRecommendation } =
      await import("./server/profile-recommender.js");
    const events = await loadAllToolCalls(cwd);
    const rec = recommendProfile(events);
    // Only print when there's actionable signal OR a clear "stay on full"
    // with enough data — skip the noise when the log is empty.
    if (rec.totalCalls > 0) {
      console.log(formatRecommendation(rec));
      console.log("");
    }
  } catch {
    /* doctor must never crash over an optional check */
  }

  // ── CLAUDE.md hygiene ──
  try {
    const r = await assessClaudeMd(cwd);
    if (r.kind === "bloated") {
      console.log("── CLAUDE.md hygiene ──");
      console.log(
        `  ⚠ ${r.path} has ${r.nonEmptyLines} non-empty lines (threshold: ${r.threshold}).`,
      );
      console.log(
        `  This file loads into every Claude Code message — splitting into docs/*.md and loading on-demand saves tokens per turn.`,
      );
      console.log("");
    }
  } catch {
    /* ignore */
  }

  // ── Ecosystem coverage ──
  // Checks which complementary tools (caveman, context-mode, cavemem) are
  // installed and prints gaps. Purely advisory — we never install anything.
  // See docs/ecosystem.md for the rationale behind the whitelist.
  try {
    const {
      checkEcosystem,
      formatEcosystemBlock,
      checkStatusline,
      formatStatuslineHint,
    } = await import("./cli/ecosystem-check.js");
    const ecosystemStatuses = checkEcosystem();
    const block = formatEcosystemBlock(ecosystemStatuses);
    if (block) {
      console.log(block);
      console.log("");
    }
    // Statusline hint — only prints when actionable (missing, or mid-upgrade
    // when caveman is present but chain wrapper isn't used).
    const statuslineHint = formatStatuslineHint(
      checkStatusline(),
      ecosystemStatuses,
    );
    if (statuslineHint) {
      console.log(statuslineHint);
      console.log("");
    }
  } catch {
    /* ecosystem check is best-effort; never break doctor */
  }

  // ── v0.34.0 health checks (Pack 2 of error-logging release) ──
  try {
    console.log("── runtime health ──");

    // Recent errors
    const recent = await loadErrors({ tail: 100 });
    if (recent.length === 0) {
      console.log(`  errors:       0 in ~/.token-pilot/hook-errors.jsonl ✓`);
    } else {
      const counts = new Map<string, number>();
      for (const r of recent) counts.set(r.code, (counts.get(r.code) ?? 0) + 1);
      const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
      console.log(`  errors:       ${recent.length} recent (top codes):`);
      for (const [code, n] of top) console.log(`                  ${String(n).padStart(3)}× ${code}`);
      console.log(`  drill-in:     token-pilot errors --tail=20`);
    }

    // Stale hook entries — user-level + project-level
    const userSettings = join(homedir(), ".claude", "settings.json");
    const projectSettings = join(cwd, ".claude", "settings.json");
    let staleCount = 0;
    for (const p of [userSettings, projectSettings]) {
      try {
        if (!existsSync(p)) continue;
        const raw = await import("node:fs/promises").then((m) => m.readFile(p, "utf-8"));
        const json = JSON.parse(raw);
        const sections = ["PreToolUse", "PostToolUse", "SessionStart"] as const;
        for (const s of sections) {
          const arr = json.hooks?.[s];
          if (!Array.isArray(arr)) continue;
          for (const entry of arr) {
            const inner = Array.isArray(entry?.hooks) ? entry.hooks : [];
            for (const h of inner) {
              if (typeof h?.command === "string") {
                if (/\/_npx\/[0-9a-f]+\//.test(h.command)) staleCount++;
                else if (/\/plugins\/cache\/token-pilot\/token-pilot\/[^/]+\//.test(h.command)) staleCount++;
              }
            }
          }
        }
      } catch {
        /* skip */
      }
    }
    if (staleCount === 0) {
      console.log(`  stale hooks:  none ✓`);
    } else {
      console.log(`  stale hooks:  ${staleCount} pinned-path entries`);
      console.log(`  fix:          token-pilot migrate-hooks`);
    }

    // Installed tp-* agents vs catalog
    let installed = 0;
    let catalog = 0;
    try {
      const fsp = await import("node:fs/promises");
      const userAgents = join(homedir(), ".claude", "agents");
      const projAgents = join(cwd, ".claude", "agents");
      const seen = new Set<string>();
      for (const dir of [userAgents, projAgents]) {
        try {
          const entries = await fsp.readdir(dir);
          for (const e of entries) {
            if (e.startsWith("tp-") && e.endsWith(".md")) seen.add(e);
          }
        } catch {
          /* missing */
        }
      }
      installed = seen.size;
      const dist = new URL("../agents", import.meta.url).pathname;
      try {
        const dEntries = await fsp.readdir(dist);
        catalog = dEntries.filter((f) => f.startsWith("tp-") && f.endsWith(".md")).length;
      } catch {
        catalog = 0;
      }
    } catch {
      /* skip */
    }
    if (catalog === 0) {
      console.log(`  tp-* agents:  could not read catalog`);
    } else if (installed === 0) {
      console.log(`  tp-* agents:  0 of ${catalog} installed`);
      console.log(`  fix:          token-pilot install-agents --scope=user`);
    } else if (installed < catalog) {
      console.log(`  tp-* agents:  ${installed} of ${catalog} installed (partial)`);
      console.log(`  fix:          token-pilot install-agents --force`);
    } else {
      console.log(`  tp-* agents:  ${installed}/${catalog} ✓`);
    }

    // WSL detection probe
    const cwdGuess = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    if (isWindowsSystemPath(cwdGuess)) {
      console.log(`  cwd:          ${cwdGuess} ✗ (Windows system path — see B8)`);
    } else {
      console.log(`  cwd:          ${cwdGuess} ✓`);
    }
    console.log("");
  } catch {
    /* health checks are best-effort */
  }

  process.exit(0);
}

export async function handleInit(targetDir: string) {
  const {
    existsSync,
    readFileSync: readFs,
    writeFileSync,
  } = await import("node:fs");
  const { join } = await import("node:path");
  const mcpPath = join(targetDir, ".mcp.json");

  const tokenPilotConfig = {
    command: "npx",
    args: ["-y", "token-pilot"],
  };

  const contextModeConfig = {
    command: "npx",
    args: ["-y", "claude-context-mode"],
  };

  let config: Record<string, any> = { mcpServers: {} };
  let existed = false;

  if (existsSync(mcpPath)) {
    try {
      config = JSON.parse(readFs(mcpPath, "utf-8"));
      if (!config.mcpServers) config.mcpServers = {};
      existed = true;
    } catch {
      console.error(`Error: ${mcpPath} exists but is not valid JSON`);
      process.exit(1);
    }
  }

  const added: string[] = [];

  if (!config.mcpServers["token-pilot"]) {
    config.mcpServers["token-pilot"] = tokenPilotConfig;
    added.push("token-pilot");
  }

  if (!config.mcpServers["context-mode"]) {
    config.mcpServers["context-mode"] = contextModeConfig;
    added.push("context-mode");
  }

  if (added.length === 0) {
    console.log(
      `✓ ${mcpPath} already has both token-pilot and context-mode configured`,
    );
    process.exit(0);
  }

  writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");

  if (existed) {
    console.log(`✓ Updated ${mcpPath} — added: ${added.join(", ")}`);
  } else {
    console.log(`✓ Created ${mcpPath} with token-pilot + context-mode`);
  }

  console.log(`\nConfigured MCP servers:`);
  console.log(
    `  • token-pilot   — enforcement layer for token-efficient reads (hook + MCP + tp-* subagents)`,
  );
  console.log(
    `  • context-mode  — shell output & large data processing (BM25 sandbox)`,
  );

  // Claude Code users benefit from six token-pilot-native subagents (tp-run,
  // tp-onboard, …). Offer installation now so they don't have to discover
  // `install-agents` from a stderr reminder later.
  const offeredAgents =
    added.includes("token-pilot") && process.stdin.isTTY === true;
  if (offeredAgents) {
    console.log("");
    const yes = await promptYesNo(
      "Install 6 tp-* subagents now (recommended for Claude Code)?",
      true,
    );
    if (yes) {
      // Delegate to the full install-agents flow: it will prompt scope,
      // handle idempotence, and persist the choice to .token-pilot.json.
      const code = await handleInstallAgents([], { projectRoot: targetDir });
      if (code !== 0) {
        console.log(
          "\n(install-agents returned non-zero; you can retry with: npx token-pilot install-agents)",
        );
      }
    } else {
      console.log(
        "\nSkipping agent install. Run later: npx token-pilot install-agents",
      );
    }
  } else if (added.includes("token-pilot")) {
    // Non-TTY path — at minimum surface the next step in the log.
    console.log(
      `\nNext step (Claude Code): npx token-pilot install-agents --scope=user|project`,
    );
  }

  // Offer `.claudeignore` — small one-time win that compounds per message.
  // Separate TTY check so a script that declined agents can still get ignore,
  // and vice versa.
  const ignoreStatus = await claudeIgnoreStatus(targetDir);
  if (offeredAgents && ignoreStatus.kind !== "user-owned") {
    console.log("");
    const yesIgnore = await promptYesNo(
      ignoreStatus.kind === "absent"
        ? "Create .claudeignore with sensible defaults (node_modules, dist, lockfiles, …)?"
        : "Refresh .claudeignore defaults (managed by token-pilot)?",
      true,
    );
    if (yesIgnore) {
      const wrote = await writeDefaultClaudeIgnore(targetDir);
      if (wrote) console.log("✓ .claudeignore written");
      else
        console.log(
          "(Skipped — existing .claudeignore is user-owned; not touched.)",
        );
    }
  } else if (ignoreStatus.kind === "absent") {
    console.log(
      `\nTip: \`npx token-pilot init\` offers to create .claudeignore — improves context by skipping node_modules, build artefacts, lockfiles.`,
    );
  }

  console.log(`\nRestart your AI assistant to activate.`);
  process.exit(0);
}

// ──────────────────────────────────────────────
// Update checking
// ──────────────────────────────────────────────

export async function checkNpmLatest(
  packageName: string,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(
      `https://registry.npmjs.org/${packageName}/latest`,
      {
        signal: controller.signal,
      },
    );
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

import type { TokenPilotConfig } from "./types.js";
import type { BinaryStatus } from "./ast-index/binary-manager.js";

export async function checkAllUpdates(
  config: TokenPilotConfig,
  binaryStatus: BinaryStatus,
): Promise<void> {
  if (!config.updates.checkOnStartup) return;

  const [tpLatest, astUpdate, cmLatest] = await Promise.allSettled([
    checkNpmLatest("token-pilot"),
    binaryStatus.available
      ? checkBinaryUpdate(binaryStatus.path)
      : Promise.resolve(null),
    checkNpmLatest("claude-context-mode"),
  ]);

  // token-pilot
  const tpVersion = getVersion();
  if (
    tpLatest.status === "fulfilled" &&
    tpLatest.value &&
    isNewerVersion(tpVersion, tpLatest.value)
  ) {
    console.error(
      `[token-pilot] Update available: ${tpVersion} → ${tpLatest.value}. Run: npx token-pilot@latest`,
    );
  }

  // ast-index
  if (astUpdate.status === "fulfilled" && astUpdate.value?.updateAvailable) {
    const { current, latest } = astUpdate.value;
    if (config.updates.autoUpdate) {
      console.error(
        `[token-pilot] Auto-updating ast-index: ${current} → ${latest}...`,
      );
      installBinary((msg) => console.error(`[token-pilot] ${msg}`)).catch(
        () => {},
      );
    } else {
      console.error(
        `[token-pilot] ast-index update: ${current} → ${latest}. Run: token-pilot install-ast-index`,
      );
    }
  }

  // context-mode (notification only — runs as separate MCP server)
  if (cmLatest.status === "fulfilled" && cmLatest.value) {
    // We can't reliably detect the currently installed version of context-mode
    // (it runs as separate process via npx). Just log latest available for doctor.
    // On startup, we only notify if explicitly useful.
  }
}

export function printHelp() {
  console.log(`token-pilot v${getVersion()} — MCP server for token-efficient code reading

Usage:
  token-pilot [project-root]        Start MCP server (default: cwd)
  token-pilot init [dir]            Create .mcp.json with token-pilot + context-mode
  token-pilot install-hook [root]   Install PreToolUse hook (Claude Code only)
  token-pilot uninstall-hook [root] Remove PreToolUse hook
  token-pilot install-ast-index     Download ast-index binary (auto on first run)
  token-pilot doctor                Run diagnostics (check ast-index, config, updates)
  token-pilot save-doc <name>       Save stdin to .token-pilot/docs/<name>.md
  token-pilot list-docs             List saved docs
  token-pilot --version             Show version
  token-pilot --help                Show this help

Quick start:
  npx token-pilot init              Setup .mcp.json (token-pilot + context-mode)

MCP Tools (22):
  smart_read, read_symbol, read_symbols, read_range, read_section, read_diff,
  read_for_edit, smart_read_many, find_usages, find_unused, related_files,
  outline, project_overview, session_analytics, code_audit, module_info,
  smart_diff, explore_area, smart_log, test_summary, session_snapshot,
  session_budget
`);
  process.exit(0);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) ===
    realpathSync(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    console.error(
      `[token-pilot] Fatal: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  });
}
