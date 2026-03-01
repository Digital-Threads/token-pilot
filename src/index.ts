#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { createServer } from './server.js';
import { installHook, uninstallHook } from './hooks/installer.js';
import { findBinary, installBinary } from './ast-index/binary-manager.js';

const SMALL_FILE_THRESHOLD = 80;

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'go', 'rs', 'java', 'kt', 'kts',
  'swift', 'cs', 'cpp', 'cc', 'cxx', 'hpp', 'c', 'h', 'php', 'rb', 'scala',
  'dart', 'lua', 'sh', 'bash', 'sql', 'r', 'vue', 'svelte', 'pl', 'pm',
  'ex', 'exs', 'groovy', 'm', 'proto', 'bsl',
]);

const args = process.argv.slice(2);

switch (args[0]) {
  case 'hook-read':
    if (!args[1]) {
      console.error('Usage: token-pilot hook-read <file-path>');
      process.exit(1);
    }
    handleHookRead(args[1]);
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

  case '--help':
  case '-h':
    printHelp();
    break;

  default:
    startServer();
    break;
}

async function startServer() {
  const projectRoot = args[0] || process.cwd();

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

function handleHookRead(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';

  if (!CODE_EXTENSIONS.has(ext)) {
    process.exit(0);
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lineCount = content.split('\n').length;
    if (lineCount <= SMALL_FILE_THRESHOLD) {
      process.exit(0);
    }
  } catch {
    process.exit(0);
  }

  const suggestion = JSON.stringify({
    decision: "suggest",
    message: `Consider using smart_read instead of Read for "${filePath}" — it returns a structural overview saving 80-95% tokens. Use read_symbol to load specific functions/methods.`,
  });

  process.stdout.write(suggestion);
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

function printHelp() {
  console.log(`token-pilot — MCP server for token-efficient code reading

Usage:
  token-pilot [project-root]        Start MCP server (default: cwd)
  token-pilot hook-read <path>      PreToolUse hook for Claude Code
  token-pilot install-hook [root]   Install hook into .claude/settings.json
  token-pilot uninstall-hook [root] Remove hook from .claude/settings.json
  token-pilot install-ast-index     Download ast-index binary (auto on first run)
  token-pilot --help                Show this help

MCP Tools (14):
  smart_read, read_symbol, read_range, read_diff, smart_read_many,
  search_code, find_usages, find_implementations, class_hierarchy,
  project_overview, export_ast_index, session_analytics, context_status, forget
`);
  process.exit(0);
}
