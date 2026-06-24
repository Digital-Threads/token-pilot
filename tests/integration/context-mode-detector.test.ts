import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { detectContextMode } from '../../src/integration/context-mode-detector.js';

describe('detectContextMode', () => {
  let testDir: string;
  let homeDir: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(async () => {
    testDir = resolve(tmpdir(), `tp-cm-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    // detectContextMode falls back to ~/.mcp.json (HOME/USERPROFILE). Point
    // those at a clean temp home with no .mcp.json so a real one on the dev
    // machine can't make the "no detection" cases report detected=true.
    homeDir = resolve(tmpdir(), `tp-cm-home-${Date.now()}`);
    await mkdir(homeDir, { recursive: true });
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    delete process.env.USERPROFILE;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
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
