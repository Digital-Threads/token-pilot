#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from './server.js';
import { installHook, uninstallHook } from './hooks/installer.js';
import { findBinary, installBinary, checkBinaryUpdate, isNewerVersion } from './ast-index/binary-manager.js';
import { loadConfig } from './config/loader.js';
import { isDangerousRoot } from './core/validation.js';

const execFileAsync = promisify(execFile);

const HOOK_DENY_THRESHOLD = 500;

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'go', 'rs', 'java', 'kt', 'kts',
  'swift', 'cs', 'cpp', 'cc', 'cxx', 'hpp', 'c', 'h', 'php', 'rb', 'scala',
  'dart', 'lua', 'sh', 'bash', 'sql', 'r', 'vue', 'svelte', 'pl', 'pm',
  'ex', 'exs', 'groovy', 'm', 'proto', 'bsl',
  'lisp', 'lsp', 'cl', 'asd',
]);

function getVersion(): string {
  try {
    const pkgPath = new URL('../package.json', import.meta.url).pathname;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

const args = process.argv.slice(2);

switch (args[0]) {
  case 'hook-read':
    handleHookRead(args[1]);
    break;

  case 'hook-edit':
    handleHookEdit();
    break;

  case 'install-hook':
    handleInstallHook(args[1] || process.cwd());
    break;

  case 'uninstall-hook':
    handleUninstallHook(args[1] || process.cwd());
    break;

  case 'install-ast-index':
    handleInstallAstIndex();
    break;

  case 'doctor':
    handleDoctor();
    break;

  case 'init':
    handleInit(args[1] || process.cwd());
    break;

  case '--version':
  case '-v':
    console.log(getVersion());
    process.exit(0);
    break;

  case '--help':
  case '-h':
    printHelp();
    break;

  default:
    startServer().catch(err => {
      console.error(`[token-pilot] Fatal: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    });
    break;
}

async function startServer() {
  let projectRoot = args[0] || process.cwd();

  // Detect git root for reliable project root
  // Try multiple sources: args[0] → INIT_CWD (npm/npx invoking dir) → PWD → cwd
  if (!args[0]) {
    const candidates = [
      process.env.INIT_CWD,   // npm/npx sets this to invoking directory
      process.env.PWD,         // shell working directory (may differ from cwd)
      process.cwd(),           // Node.js working directory
    ].filter((c): c is string => !!c && c !== '/');

    let detected = false;
    for (const candidate of candidates) {
      if (isDangerousRoot(candidate)) continue;
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
          cwd: candidate,
          timeout: 3000,
        });
        const gitRoot = stdout.trim();
        if (gitRoot && !isDangerousRoot(gitRoot)) {
          projectRoot = gitRoot;
          console.error(`[token-pilot] project root: ${projectRoot} (git from ${candidate === process.env.INIT_CWD ? 'INIT_CWD' : candidate === process.env.PWD ? 'PWD' : 'cwd'})`);
          detected = true;
          break;
        }
      } catch {
        // Not a git repo at this candidate — try next
      }
    }

    if (!detected) {
      // Use best non-dangerous candidate as fallback even without git
      const fallback = candidates.find(c => !isDangerousRoot(c));
      if (fallback) {
        projectRoot = fallback;
        console.error(`[token-pilot] project root: ${projectRoot} (${fallback === process.env.INIT_CWD ? 'INIT_CWD' : 'PWD'}, not a git repo)`);
      } else {
        console.error(`[token-pilot] project root: ${projectRoot} (cwd, not a git repo)`);
      }
    }
  }

  // Guard: refuse to use dangerous roots that would index the entire disk
  if (isDangerousRoot(projectRoot)) {
    console.error(
      `[token-pilot] WARNING: project root "${projectRoot}" is too broad (system/home directory).\n` +
      `  ast-index will be disabled to prevent indexing the entire filesystem.\n` +
      `  Fix: pass project path explicitly — token-pilot /path/to/project\n` +
      `  Or configure mcpServers with "args": ["/path/to/project"]`
    );
  }

  // Non-blocking update check for all components (logs to stderr, never blocks startup)
  const config = await loadConfig(projectRoot);
  const binaryStatus = await findBinary(config.astIndex.binaryPath);
  checkAllUpdates(config, binaryStatus).catch(() => { /* ignore */ });

  // Auto-install PreToolUse hook (non-blocking, Claude Code only)
  installHook(projectRoot).then(result => {
    if (result.installed) {
      console.error(`[token-pilot] hook auto-installed: ${result.message}`);
    }
  }).catch(() => { /* ignore — not Claude Code or no .claude dir */ });

  const server = await createServer(projectRoot, {
    skipAstIndex: isDangerousRoot(projectRoot),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });
}

function handleHookRead(filePathArg?: string) {
  // Parse stdin (Claude Code hook format) to get tool_input
  let filePath = filePathArg;
  let hasOffset = false;
  let hasLimit = false;

  if (!filePath) {
    try {
      const stdin = readFileSync(0, 'utf-8');
      const input = JSON.parse(stdin);
      filePath = input?.tool_input?.file_path;
      hasOffset = input?.tool_input?.offset != null;
      hasLimit = input?.tool_input?.limit != null;
    } catch {
      process.exit(0);
    }
  }

  if (!filePath) {
    process.exit(0);
  }

  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';

  // Non-code files — allow Read without interference
  if (!CODE_EXTENSIONS.has(ext)) {
    process.exit(0);
  }

  // Bounded Read (has offset or limit) — allow, AI is reading a specific section
  if (hasOffset || hasLimit) {
    process.exit(0);
  }

  // Check file size
  let lineCount = 0;
  try {
    const content = readFileSync(filePath, 'utf-8');
    lineCount = content.split('\n').length;
    if (lineCount <= HOOK_DENY_THRESHOLD) {
      process.exit(0);
    }
  } catch {
    process.exit(0);
  }

  // Large code file, unbounded Read → DENY
  // permissionDecisionReason is shown to Claude (not user) per official docs
  const deny = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `File "${filePath}" has ${lineCount} lines. Use smart_read("${filePath}") for structural overview, or read_for_edit("${filePath}", symbol="<name>") for edit context. Bounded Read with offset/limit is still allowed.`,
    },
  });

  process.stdout.write(deny);
  process.exit(0);
}

function handleHookEdit() {
  // Parse stdin for Edit tool_input
  let filePath: string | undefined;

  try {
    const stdin = readFileSync(0, 'utf-8');
    const input = JSON.parse(stdin);
    filePath = input?.tool_input?.file_path;
  } catch {
    process.exit(0);
  }

  if (!filePath) {
    process.exit(0);
  }

  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';

  // Only add context for code files
  if (!CODE_EXTENSIONS.has(ext)) {
    process.exit(0);
  }

  // Add additionalContext suggesting read_for_edit — doesn't block Edit
  const context = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: `TIP: Use read_for_edit("${filePath}", symbol="<name>") to get minimal raw code for Edit's old_string — 97% fewer tokens than Read.`,
    },
  });

  process.stdout.write(context);
  process.exit(0);
}


async function handleInstallHook(projectRoot: string) {
  const result = await installHook(projectRoot);
  console.log(result.message);
  process.exit(result.installed ? 0 : 1);
}

async function handleUninstallHook(projectRoot: string) {
  const result = await uninstallHook(projectRoot);
  console.log(result.message);
  process.exit(result.removed ? 0 : 1);
}

async function handleInstallAstIndex() {
  const status = await findBinary();
  if (status.available) {
    // Check if update is available
    const update = await checkBinaryUpdate(status.path);
    if (update.updateAvailable) {
      console.log(`ast-index ${update.current} installed, updating to ${update.latest}...`);
    } else {
      console.log(`ast-index ${status.version} already up to date at ${status.path} (${status.source})`);
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

async function handleDoctor() {
  const version = getVersion();
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const cwd = process.cwd();

  console.log(`token-pilot doctor v${version}\n`);

  // ── Environment ──
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1), 10);
  console.log(`Node.js:        ${nodeVersion} ${nodeMajor >= 18 ? '✓' : '✗ (requires >=18)'}`);

  const configPath = join(cwd, '.token-pilot.json');
  console.log(`config:         ${existsSync(configPath) ? configPath + ' ✓' : 'default (no .token-pilot.json)'}`);

  const gitDir = join(cwd, '.git');
  console.log(`git repo:       ${existsSync(gitDir) ? 'yes ✓' : 'no (read_diff/git features unavailable)'}`);
  console.log('');

  // ── token-pilot ──
  console.log('── token-pilot ──');
  console.log(`  installed:    ${version}`);
  const tpLatest = await checkNpmLatest('token-pilot');
  if (tpLatest) {
    if (isNewerVersion(version, tpLatest)) {
      console.log(`  latest:       ${tpLatest} (update available!)`);
      console.log(`  run:          npx clear-npx-cache && npx -y token-pilot@latest`);
    } else {
      console.log(`  latest:       ${tpLatest} ✓ (up to date)`);
    }
  } else {
    console.log(`  latest:       could not check (network error)`);
  }
  console.log('');

  // ── ast-index ──
  console.log('── ast-index ──');
  const astStatus = await findBinary();
  if (astStatus.available) {
    console.log(`  installed:    ${astStatus.version} (${astStatus.source}: ${astStatus.path})`);
    const astUpdate = await checkBinaryUpdate(astStatus.path);
    if (astUpdate.updateAvailable) {
      console.log(`  latest:       ${astUpdate.latest} (update available!)`);
      console.log(`  run:          npx token-pilot install-ast-index`);
    } else if (astUpdate.latest) {
      console.log(`  latest:       ${astUpdate.latest} ✓ (up to date)`);
    }

    const config = await loadConfig(cwd);
    console.log(`  auto-update:  ${config.updates.autoUpdate ? 'enabled ✓' : 'disabled (set updates.autoUpdate=true in .token-pilot.json)'}`);
  } else {
    console.log(`  installed:    not found ✗`);
    console.log(`  run:          npx token-pilot install-ast-index`);
  }
  console.log('');

  // ── context-mode ──
  console.log('── context-mode ──');
  const { detectContextMode } = await import('./integration/context-mode-detector.js');
  const cmStatus = await detectContextMode(cwd);
  console.log(`  detected:     ${cmStatus.detected ? `yes (${cmStatus.source})` : 'no'}`);
  const cmLatest = await checkNpmLatest('claude-context-mode');
  if (cmLatest) {
    console.log(`  latest npm:   ${cmLatest}`);
  }
  if (!cmStatus.detected) {
    console.log(`  setup:        npx token-pilot init`);
  }
  console.log('');

  process.exit(0);
}

async function handleInit(targetDir: string) {
  const { existsSync, readFileSync: readFs, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const mcpPath = join(targetDir, '.mcp.json');

  const tokenPilotConfig = {
    command: 'npx',
    args: ['-y', 'token-pilot'],
  };

  const contextModeConfig = {
    command: 'npx',
    args: ['-y', 'claude-context-mode'],
  };

  let config: Record<string, any> = { mcpServers: {} };
  let existed = false;

  if (existsSync(mcpPath)) {
    try {
      config = JSON.parse(readFs(mcpPath, 'utf-8'));
      if (!config.mcpServers) config.mcpServers = {};
      existed = true;
    } catch {
      console.error(`Error: ${mcpPath} exists but is not valid JSON`);
      process.exit(1);
    }
  }

  const added: string[] = [];

  if (!config.mcpServers['token-pilot']) {
    config.mcpServers['token-pilot'] = tokenPilotConfig;
    added.push('token-pilot');
  }

  if (!config.mcpServers['context-mode']) {
    config.mcpServers['context-mode'] = contextModeConfig;
    added.push('context-mode');
  }

  if (added.length === 0) {
    console.log(`✓ ${mcpPath} already has both token-pilot and context-mode configured`);
    process.exit(0);
  }

  writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n');

  if (existed) {
    console.log(`✓ Updated ${mcpPath} — added: ${added.join(', ')}`);
  } else {
    console.log(`✓ Created ${mcpPath} with token-pilot + context-mode`);
  }

  console.log(`\nConfigured MCP servers:`);
  console.log(`  • token-pilot   — AST-aware code reading (60-80% token savings)`);
  console.log(`  • context-mode  — shell output & large data processing (BM25 sandbox)`);
  console.log(`\nRestart your AI assistant to activate.`);
  process.exit(0);
}

// ──────────────────────────────────────────────
// Update checking
// ──────────────────────────────────────────────

async function checkNpmLatest(packageName: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = await resp.json() as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

import type { TokenPilotConfig } from './types.js';
import type { BinaryStatus } from './ast-index/binary-manager.js';

async function checkAllUpdates(config: TokenPilotConfig, binaryStatus: BinaryStatus): Promise<void> {
  if (!config.updates.checkOnStartup) return;

  const [tpLatest, astUpdate, cmLatest] = await Promise.allSettled([
    checkNpmLatest('token-pilot'),
    binaryStatus.available ? checkBinaryUpdate(binaryStatus.path) : Promise.resolve(null),
    checkNpmLatest('claude-context-mode'),
  ]);

  // token-pilot
  const tpVersion = getVersion();
  if (tpLatest.status === 'fulfilled' && tpLatest.value && isNewerVersion(tpVersion, tpLatest.value)) {
    console.error(`[token-pilot] Update available: ${tpVersion} → ${tpLatest.value}. Run: npx token-pilot@latest`);
  }

  // ast-index
  if (astUpdate.status === 'fulfilled' && astUpdate.value?.updateAvailable) {
    const { current, latest } = astUpdate.value;
    if (config.updates.autoUpdate) {
      console.error(`[token-pilot] Auto-updating ast-index: ${current} → ${latest}...`);
      installBinary(msg => console.error(`[token-pilot] ${msg}`)).catch(() => {});
    } else {
      console.error(`[token-pilot] ast-index update: ${current} → ${latest}. Run: token-pilot install-ast-index`);
    }
  }

  // context-mode (notification only — runs as separate MCP server)
  if (cmLatest.status === 'fulfilled' && cmLatest.value) {
    // We can't reliably detect the currently installed version of context-mode
    // (it runs as separate process via npx). Just log latest available for doctor.
    // On startup, we only notify if explicitly useful.
  }
}

function printHelp() {
  console.log(`token-pilot v${getVersion()} — MCP server for token-efficient code reading

Usage:
  token-pilot [project-root]        Start MCP server (default: cwd)
  token-pilot init [dir]            Create .mcp.json with token-pilot + context-mode
  token-pilot install-hook [root]   Install PreToolUse hook (Claude Code only)
  token-pilot uninstall-hook [root] Remove PreToolUse hook
  token-pilot install-ast-index     Download ast-index binary (auto on first run)
  token-pilot doctor                Run diagnostics (check ast-index, config, updates)
  token-pilot --version             Show version
  token-pilot --help                Show this help

Quick start:
  npx token-pilot init              Setup .mcp.json (token-pilot + context-mode)

MCP Tools (12):
  smart_read, read_symbol, read_range, read_diff, smart_read_many, read_for_edit,
  find_usages, find_unused, related_files, outline,
  project_overview, session_analytics
`);
  process.exit(0);
}
