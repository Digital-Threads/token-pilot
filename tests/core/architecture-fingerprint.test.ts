import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadFingerprint,
  saveFingerprint,
  buildFingerprint,
  formatCachedFingerprint,
} from '../../src/core/architecture-fingerprint.js';

describe('architecture-fingerprint', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tp-fp-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('loadFingerprint', () => {
    it('returns null when no fingerprint file exists', async () => {
      const result = await loadFingerprint(tempDir);
      expect(result).toBeNull();
    });

    it('loads valid fingerprint from disk', async () => {
      const fp = {
        version: '0.14.0',
        generatedAt: Date.now(),
        frameworks: ['vitest'],
        entrypoints: ['src'],
        moduleCount: 5,
        sourceFileCount: 42,
        namingConventions: ['.test.ts(12)'],
      };
      await saveFingerprint(tempDir, fp);

      const loaded = await loadFingerprint(tempDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe('0.14.0');
      expect(loaded!.frameworks).toEqual(['vitest']);
      expect(loaded!.sourceFileCount).toBe(42);
    });

    it('returns null for invalid JSON', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(tempDir, '.token-pilot-fingerprint.json'), 'not json', 'utf-8');

      const result = await loadFingerprint(tempDir);
      expect(result).toBeNull();
    });

    it('returns null for missing version field', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        join(tempDir, '.token-pilot-fingerprint.json'),
        JSON.stringify({ generatedAt: Date.now() }),
        'utf-8',
      );

      const result = await loadFingerprint(tempDir);
      expect(result).toBeNull();
    });
  });

  describe('saveFingerprint', () => {
    it('writes fingerprint as formatted JSON', async () => {
      const fp = {
        version: '0.14.0',
        generatedAt: 1000,
        frameworks: ['express'],
        entrypoints: ['src'],
        moduleCount: 3,
        sourceFileCount: 20,
        namingConventions: [],
      };

      await saveFingerprint(tempDir, fp);

      const raw = await readFile(join(tempDir, '.token-pilot-fingerprint.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe('0.14.0');
      expect(parsed.frameworks).toEqual(['express']);
      expect(raw.endsWith('\n')).toBe(true);
    });
  });

  describe('buildFingerprint', () => {
    it('extracts project type from overview text', () => {
      const text = 'TYPE (ast-index): typescript (42 files)\nFRAMEWORKS: vitest, express';
      const fp = buildFingerprint(text, '0.14.0');

      expect(fp.projectType).toBe('typescript (42 files)');
      expect(fp.frameworks).toEqual(['vitest', 'express']);
      expect(fp.version).toBe('0.14.0');
      expect(fp.sourceFileCount).toBe(42);
    });

    it('extracts naming patterns', () => {
      const text = 'PATTERNS: .test.ts(12), .spec.ts(3)';
      const fp = buildFingerprint(text, '0.14.0');

      expect(fp.namingConventions).toEqual(['.test.ts(12)', '.spec.ts(3)']);
    });

    it('extracts module count from MAP entries', () => {
      const text = [
        'MAP:',
        '  src/core (15 files)',
        '  src/handlers (8 files)',
        '  tests (20 files)',
      ].join('\n');

      const fp = buildFingerprint(text, '0.14.0');
      expect(fp.moduleCount).toBe(3);
      expect(fp.entrypoints).toContain('src/core');
    });

    it('handles empty overview text', () => {
      const fp = buildFingerprint('', '0.14.0');

      expect(fp.version).toBe('0.14.0');
      expect(fp.frameworks).toEqual([]);
      expect(fp.moduleCount).toBe(0);
    });
  });

  describe('formatCachedFingerprint', () => {
    it('formats fingerprint as readable summary', () => {
      const fp = {
        version: '0.14.0',
        generatedAt: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
        projectType: 'typescript',
        frameworks: ['vitest', 'express'],
        entrypoints: ['src'],
        moduleCount: 5,
        sourceFileCount: 42,
        namingConventions: ['.test.ts(12)'],
      };

      const output = formatCachedFingerprint(fp);

      expect(output).toContain('Cached Architecture');
      expect(output).toContain('TYPE: typescript');
      expect(output).toContain('FRAMEWORKS: vitest, express');
      expect(output).toContain('FILES: 42');
      expect(output).toContain('MODULES: 5');
      expect(output).toContain('v0.14.0');
    });

    it('omits empty sections', () => {
      const fp = {
        version: '0.14.0',
        generatedAt: Date.now(),
        frameworks: [],
        entrypoints: [],
        moduleCount: 0,
        sourceFileCount: 0,
        namingConventions: [],
      };

      const output = formatCachedFingerprint(fp);
      expect(output).not.toContain('TYPE:');
      expect(output).not.toContain('FRAMEWORKS:');
      expect(output).not.toContain('FILES:');
    });
  });
});
