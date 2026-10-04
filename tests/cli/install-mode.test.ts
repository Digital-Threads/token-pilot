import { describe, it, expect } from 'vitest';
import { describeInstallMode } from '../../src/cli/install-mode.js';

describe('doctor install mode', () => {
  it('inside Claude Code the plugin root says plugin', () => {
    expect(describeInstallMode({ pluginRoot: '/p/root', scriptPath: '/x/dist/index.js', pluginEnabled: true }))
      .toBe('plugin (/p/root)');
  });

  it('the plugin binary run from a shell is still the plugin', () => {
    const script = '/home/u/.claude/plugins/cache/token-pilot/token-pilot/1.0.1/dist/index.js';
    expect(describeInstallMode({ scriptPath: script, pluginEnabled: true }))
      .toBe('plugin (/home/u/.claude/plugins/cache/token-pilot/token-pilot/1.0.1)');
  });

  it('an npm binary run from a shell names the enabled plugin Claude Code really uses', () => {
    const mode = describeInstallMode({ scriptPath: '/usr/lib/node_modules/token-pilot/dist/index.js', pluginEnabled: true });
    expect(mode).toMatch(/^npm \/ npx/);
    expect(mode).toMatch(/plugin/);
  });

  it('npm without the plugin stays npm', () => {
    expect(describeInstallMode({ scriptPath: '/usr/lib/node_modules/token-pilot/dist/index.js', pluginEnabled: false }))
      .toBe('npm / npx');
  });

  it('a worktree checkout is a contributor install', () => {
    expect(describeInstallMode({ scriptPath: '/r/.claude/worktrees/a/dist/index.js', pluginEnabled: false }))
      .toBe('dev / worktree (contributor)');
  });
});
