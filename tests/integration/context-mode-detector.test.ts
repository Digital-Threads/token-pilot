import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { detectContextMode } from '../../src/integration/context-mode-detector.js';

describe('detectContextMode', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = resolve(tmpdir(), `tp-cm-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns detected=false when no .mcp.json exists', async () => {
    const result = await detectContextMode(testDir);
    expect(result.detected).toBe(false);
    expect(result.source).toBe('none');
  });

  it('detects context-mode from project .mcp.json by server name', async () => {
    const mcpConfig = {
      mcpServers: {
        'context-mode': {
          command: 'sh',
          args: ['start.sh'],
        },
      },
    };
    await writeFile(resolve(testDir, '.mcp.json'), JSON.stringify(mcpConfig));

    const result = await detectContextMode(testDir);
    expect(result.detected).toBe(true);
    expect(result.source).toBe('mcp-json');
  });

  it('detects context-mode from .mcp.json by command content', async () => {
    const mcpConfig = {
      mcpServers: {
        'my-plugin': {
          command: 'npx',
          args: ['context-mode', 'start'],
        },
      },
    };
    await writeFile(resolve(testDir, '.mcp.json'), JSON.stringify(mcpConfig));

    const result = await detectContextMode(testDir);
    expect(result.detected).toBe(true);
    expect(result.source).toBe('mcp-json');
  });

  it('returns detected=false when .mcp.json has unrelated servers', async () => {
    const mcpConfig = {
      mcpServers: {
        'some-other-tool': {
          command: 'node',
          args: ['server.js'],
        },
      },
    };
    await writeFile(resolve(testDir, '.mcp.json'), JSON.stringify(mcpConfig));

    const result = await detectContextMode(testDir);
    expect(result.detected).toBe(false);
  });

  it('respects config override true', async () => {
    const result = await detectContextMode(testDir, true);
    expect(result.detected).toBe(true);
    expect(result.source).toBe('config');
  });

  it('respects config override false', async () => {
    // Even if .mcp.json exists, override=false wins
    const mcpConfig = {
      mcpServers: {
        'context-mode': { command: 'sh', args: ['start.sh'] },
      },
    };
    await writeFile(resolve(testDir, '.mcp.json'), JSON.stringify(mcpConfig));

    const result = await detectContextMode(testDir, false);
    expect(result.detected).toBe(false);
    expect(result.source).toBe('none');
  });

  it('handles malformed .mcp.json gracefully', async () => {
    await writeFile(resolve(testDir, '.mcp.json'), 'not valid json{{{');

    const result = await detectContextMode(testDir);
    expect(result.detected).toBe(false);
  });

  it('includes tool prefix in all results', async () => {
    const result = await detectContextMode(testDir);
    expect(result.toolPrefix).toContain('context-mode');
  });
});
