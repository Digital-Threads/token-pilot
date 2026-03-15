import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installHook, uninstallHook } from '../../src/hooks/installer.js';

describe('Hook Installer', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'token-pilot-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('installs hook in fresh project (no .claude dir)', async () => {
    const result = await installHook(tempDir);
    expect(result.installed).toBe(true);
    expect(result.message).toContain('Hooks installed');

    const settings = JSON.parse(await readFile(join(tempDir, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Read');
    expect(settings.hooks.PreToolUse[1].matcher).toBe('Edit');
  });

  it('installs hook alongside existing settings', async () => {
    await mkdir(join(tempDir, '.claude'), { recursive: true });
    await writeFile(
      join(tempDir, '.claude', 'settings.json'),
      JSON.stringify({ someOtherSetting: true })
    );

    const result = await installHook(tempDir);
    expect(result.installed).toBe(true);

    const settings = JSON.parse(await readFile(join(tempDir, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.someOtherSetting).toBe(true);
    expect(settings.hooks.PreToolUse).toHaveLength(2);
  });

  it('does not double-install', async () => {
    await installHook(tempDir);
    const result = await installHook(tempDir);
    expect(result.installed).toBe(false);
    expect(result.message).toContain('already installed');
  });

  it('uninstalls hook', async () => {
    await installHook(tempDir);
    const result = await uninstallHook(tempDir);
    expect(result.removed).toBe(true);

    const settings = JSON.parse(await readFile(join(tempDir, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks).toBeUndefined();
  });

  it('uninstall reports nothing to remove', async () => {
    const result = await uninstallHook(tempDir);
    expect(result.removed).toBe(false);
    expect(result.fatal).toBe(false);
  });

  it('reports invalid JSON as a fatal install error', async () => {
    await mkdir(join(tempDir, '.claude'), { recursive: true });
    await writeFile(join(tempDir, '.claude', 'settings.json'), '{not json');

    const result = await installHook(tempDir);
    expect(result.installed).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.message).toContain('invalid JSON');
  });

  it('keeps packaged hook config in sync with installer hooks', async () => {
    const packaged = JSON.parse(
      await readFile(join(process.cwd(), '.claude-plugin', 'hooks', 'hooks.json'), 'utf-8'),
    );

    const preToolUse = packaged.hooks.PreToolUse;
    expect(preToolUse).toHaveLength(2);
    expect(preToolUse.map((hook: { matcher: string }) => hook.matcher)).toEqual(['Read', 'Edit']);
    expect(preToolUse[0].hooks[0].command).toContain('hook-read');
    expect(preToolUse[1].hooks[0].command).toContain('hook-edit');
  });
});
