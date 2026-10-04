import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectContextMode,
  enabledPluginIds,
  contextModeExecuteTool,
} from '../../src/integration/context-mode-detector.js';

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

  describe('Claude Code plugin installs (no .mcp.json)', () => {
    let savedConfigDir: string | undefined;
    beforeEach(() => {
      savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
      delete process.env.CLAUDE_CONFIG_DIR;
    });
    afterEach(() => {
      if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    });

    const settings = async (dir: string, enabledPlugins: Record<string, boolean>, file = 'settings.json') => {
      await mkdir(resolve(dir, '.claude'), { recursive: true });
      await writeFile(resolve(dir, '.claude', file), JSON.stringify({ enabledPlugins }));
    };

    it('detects context-mode enabled as a plugin in user settings', async () => {
      await settings(homeDir, { 'context-mode@context-mode': true, 'token-pilot@token-pilot': true });
      const result = await detectContextMode(testDir);
      expect(result).toMatchObject({ detected: true, source: 'plugin' });
      expect(contextModeExecuteTool(testDir)).toBeDefined();
    });

    it('detects it from project settings too', async () => {
      await settings(testDir, { 'context-mode@claude-context-mode': true }, 'settings.local.json');
      expect((await detectContextMode(testDir)).detected).toBe(true);
    });

    it('a plugin switched off is not detected', async () => {
      await settings(homeDir, { 'context-mode@context-mode': false });
      expect((await detectContextMode(testDir)).detected).toBe(false);
      expect(contextModeExecuteTool(testDir)).toBeUndefined();
    });

    it('project settings override user settings', async () => {
      await settings(homeDir, { 'context-mode@context-mode': true });
      await settings(testDir, { 'context-mode@context-mode': false });
      expect((await detectContextMode(testDir)).detected).toBe(false);
    });

    it('lists enabled plugin ids', async () => {
      await settings(homeDir, { 'token-pilot@token-pilot': true, 'caveman@caveman': false });
      expect(enabledPluginIds(testDir)).toEqual(['token-pilot@token-pilot']);
    });

    // The post-bash hint names the tool to call: the plugin's name for a
    // plugin install, the bare server's name for a `.mcp.json` one.
    describe('contextModeExecuteTool', () => {
      const PLUGIN_TOOL = 'mcp__plugin_context-mode_context-mode__ctx_execute';

      it('names the plugin tool for a plugin enabled in user settings', async () => {
        await settings(homeDir, { 'context-mode@context-mode': true });
        expect(contextModeExecuteTool(testDir)).toBe(PLUGIN_TOOL);
      });

      it('reads user settings from CLAUDE_CONFIG_DIR', async () => {
        const configDir = resolve(homeDir, 'alt-config');
        await mkdir(configDir, { recursive: true });
        await writeFile(resolve(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'context-mode@context-mode': true } }));
        process.env.CLAUDE_CONFIG_DIR = configDir;
        expect(contextModeExecuteTool(testDir)).toBe(PLUGIN_TOOL);
      });

      it('names the plugin tool for a plugin enabled only in project settings', async () => {
        await settings(testDir, { 'context-mode@context-mode': true }, 'settings.local.json');
        expect(contextModeExecuteTool(testDir)).toBe(PLUGIN_TOOL);
      });

      it('a project-level false switches the plugin off', async () => {
        await settings(homeDir, { 'context-mode@context-mode': true });
        await settings(testDir, { 'context-mode@context-mode': false });
        expect(contextModeExecuteTool(testDir)).toBeUndefined();
      });

      it('names the bare server tool for a .mcp.json install', async () => {
        await writeFile(resolve(testDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'context-mode': { command: 'npx', args: ['context-mode'] } } }));
        expect(contextModeExecuteTool(testDir)).toBe('mcp__context-mode__ctx_execute');
      });

      it('is undefined when context-mode is not installed', () => {
        expect(contextModeExecuteTool(testDir)).toBeUndefined();
      });
    });
  });
});
