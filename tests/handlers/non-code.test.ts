import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isNonCodeStructured, handleNonCodeRead } from '../../src/handlers/non-code.js';
import { ContextRegistry } from '../../src/core/context-registry.js';

describe('isNonCodeStructured', () => {
  it('returns true for JSON', () => {
    expect(isNonCodeStructured('/foo/bar.json')).toBe(true);
  });

  it('returns true for YAML', () => {
    expect(isNonCodeStructured('config.yaml')).toBe(true);
    expect(isNonCodeStructured('config.yml')).toBe(true);
  });

  it('returns true for Markdown', () => {
    expect(isNonCodeStructured('README.md')).toBe(true);
    expect(isNonCodeStructured('docs/guide.markdown')).toBe(true);
  });

  it('returns true for TOML', () => {
    expect(isNonCodeStructured('Cargo.toml')).toBe(true);
  });

  it('returns false for code files', () => {
    expect(isNonCodeStructured('app.ts')).toBe(false);
    expect(isNonCodeStructured('main.py')).toBe(false);
    expect(isNonCodeStructured('lib.rs')).toBe(false);
  });

  it('returns false for unknown extensions', () => {
    expect(isNonCodeStructured('file.xyz')).toBe(false);
  });
});

describe('handleNonCodeRead context-mode delegation', () => {
  let testDir: string;
  let registry: ContextRegistry;

  beforeEach(async () => {
    testDir = resolve(tmpdir(), `tp-noncode-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    registry = new ContextRegistry();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('appends advisory for large non-code files when context-mode detected', async () => {
    // Create a large JSON file (> 200 lines)
    const bigJson = JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item-${i}` })) }, null, 2);
    await writeFile(resolve(testDir, 'big.json'), bigJson);

    const result = await handleNonCodeRead('big.json', testDir, registry, {
      contextModeStatus: { detected: true, source: 'mcp-json', toolPrefix: 'mcp__cm__' },
      largeNonCodeThreshold: 10, // low threshold so our file triggers it
      adviseDelegation: true,
    });

    expect(result).not.toBeNull();
    const text = result!.content[0].text;
    expect(text).toContain('ADVISORY');
    expect(text).toContain('context-mode');
    expect(text).toContain('execute_file');
  });

  it('does not append advisory for small non-code files', async () => {
    await writeFile(resolve(testDir, 'small.json'), '{"a": 1}');

    const result = await handleNonCodeRead('small.json', testDir, registry, {
      contextModeStatus: { detected: true, source: 'mcp-json', toolPrefix: 'mcp__cm__' },
      largeNonCodeThreshold: 200,
      adviseDelegation: true,
    });

    expect(result).not.toBeNull();
    expect(result!.content[0].text).not.toContain('ADVISORY');
  });

  it('does not append advisory when context-mode is not detected', async () => {
    const bigJson = JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: i })) }, null, 2);
    await writeFile(resolve(testDir, 'big.json'), bigJson);

    const result = await handleNonCodeRead('big.json', testDir, registry, {
      contextModeStatus: { detected: false, source: 'none', toolPrefix: '' },
      largeNonCodeThreshold: 10,
      adviseDelegation: true,
    });

    expect(result).not.toBeNull();
    expect(result!.content[0].text).not.toContain('ADVISORY');
  });

  it('does not append advisory when adviseDelegation is false', async () => {
    const bigJson = JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: i })) }, null, 2);
    await writeFile(resolve(testDir, 'big.json'), bigJson);

    const result = await handleNonCodeRead('big.json', testDir, registry, {
      contextModeStatus: { detected: true, source: 'mcp-json', toolPrefix: 'mcp__cm__' },
      largeNonCodeThreshold: 10,
      adviseDelegation: false,
    });

    expect(result).not.toBeNull();
    expect(result!.content[0].text).not.toContain('ADVISORY');
  });
});
