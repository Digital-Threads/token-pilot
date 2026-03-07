#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from './server.js';
import { installHook, uninstallHook } from './hooks/installer.js';
import { findBinary, installBinary } from './ast-index/binary-manager.js';

const execFileAsync = promisify(execFile);

const HOOK_DENY_THRESHOLD = 500;

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'go', 'rs', 'java', 'kt', 'kts',
  'swift', 'cs', 'cpp', 'cc', 'cxx', 'hpp', 'c', 'h', 'php', 'rb', 'scala',
  'dart', 'lua', 'sh', 'bash', 'sql', 'r', 'vue', 'svelte', 'pl', 'pm',
  'ex', 'exs', 'groovy', 'm', 'proto', 'bsl',
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

  // Detect git root for reliable project root (avoids cwd=/home/user issues)
  if (!args[0]) {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd: process.cwd(),
        timeout: 3000,
      });
      const gitRoot = stdout.trim();
      if (gitRoot) {
        projectRoot = gitRoot;
        console.error(`[token-pilot] project root: ${projectRoot} (git)`);
      }
    } catch {
      console.error(`[token-pilot] project root: ${projectRoot} (cwd, not a git repo)`);
    }
  }

  // Non-blocking update check (logs to stderr, never blocks startup)
  checkLatestVersion().then(latest => {
    if (latest && latest !== getVersion()) {
      console.error(`[token-pilot] Update available: ${getVersion()} → ${latest}. Run: npx token-pilot@latest`);
    }
  }).catch(() => { /* ignore */ });

  // Auto-install PreToolUse hook (non-blocking, Claude Code only)
  installHook(projectRoot).then(result => {
    if (result.installed) {
      console.error(`[token-pilot] hook auto-installed: ${result.message}`);
    }
  }).catch(() => { /* ignore — not Claude Code or no .claude dir */ });

  const server = await createServer(projectRoot);
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
    console.log(`ast-index ${status.version} already available at ${status.path} (${status.source})`);
    process.exit(0);
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
  console.log(`token-pilot v${version}\n`);

  // Check Node.js version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1), 10);
  console.log(`Node.js:      ${nodeVersion} ${nodeMajor >= 18 ? '✓' : '✗ (requires >=18)'}`);

  // Check ast-index
  const astStatus = await findBinary();
  if (astStatus.available) {
    console.log(`ast-index:    ${astStatus.version} ✓ (${astStatus.source}: ${astStatus.path})`);
  } else {
    console.log(`ast-index:    not found ✗`);
    console.log(`              Run: npx token-pilot install-ast-index`);
  }

  // Check for updates
  const latest = await checkLatestVersion();
  if (latest) {
    if (latest !== version) {
      console.log(`npm version:  ${latest} (current: ${version} — update available!)`);
      console.log(`              Run: npx clear-npx-cache && npx -y token-pilot@latest`);
    } else {
      console.log(`npm version:  ${latest} ✓ (up to date)`);
    }
  } else {
    console.log(`npm version:  could not check (network error)`);
  }

  // Check config
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const cwd = process.cwd();
  const configPath = join(cwd, '.token-pilot.json');
  console.log(`config:       ${existsSync(configPath) ? configPath + ' ✓' : 'default (no .token-pilot.json)'}`);

  // Check git
  const gitDir = join(cwd, '.git');
  console.log(`git repo:     ${existsSync(gitDir) ? 'yes ✓' : 'no (read_diff/git features unavailable)'}`);

  console.log('');
  process.exit(0);
}

async function checkLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch('https://registry.npmjs.org/token-pilot/latest', {
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

function printHelp() {
  console.log(`token-pilot v${getVersion()} — MCP server for token-efficient code reading

Usage:
  token-pilot [project-root]        Start MCP server (default: cwd)
  token-pilot hook-read <path>      PreToolUse hook for Claude Code
  token-pilot install-hook [root]   Install hook into .claude/settings.json
  token-pilot uninstall-hook [root] Remove hook from .claude/settings.json
  token-pilot install-ast-index     Download ast-index binary (auto on first run)
  token-pilot doctor                Run diagnostics (check ast-index, config, updates)
  token-pilot --version             Show version
  token-pilot --help                Show this help

MCP Tools (12):
  smart_read, read_symbol, read_range, read_diff, smart_read_many, read_for_edit,
  find_usages, find_unused, related_files, outline,
  project_overview, session_analytics
`);
  process.exit(0);
}
