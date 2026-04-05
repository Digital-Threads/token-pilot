import { describe, it, expect } from 'vitest';
import { parseJsonSections, findJsonSection, extractJsonSectionContent } from '../../src/handlers/json-sections.js';

const SAMPLE_JSON = [
  '{',
  '  "name": "my-project",',
  '  "version": "1.0.0",',
  '  "scripts": {',
  '    "build": "tsc",',
  '    "test": "vitest",',
  '    "lint": "eslint ."',
  '  },',
  '  "dependencies": {',
  '    "express": "^4.18.0",',
  '    "zod": "^3.22.0"',
  '  },',
  '  "devDependencies": {',
  '    "typescript": "^5.3.0",',
  '    "vitest": "^1.0.0"',
  '  }',
  '}',
].join('\n');

describe('parseJsonSections', () => {
  it('parses top-level keys with line ranges', () => {
    const sections = parseJsonSections(SAMPLE_JSON);
    expect(sections.length).toBeGreaterThanOrEqual(5);
    const names = sections.map(s => s.heading);
    expect(names).toContain('name');
    expect(names).toContain('scripts');
    expect(names).toContain('dependencies');
    expect(names).toContain('devDependencies');
  });

  it('scripts section contains build/test/lint', () => {
    const sections = parseJsonSections(SAMPLE_JSON);
    const lines = SAMPLE_JSON.split('\n');
    const scripts = findJsonSection(sections, 'scripts')!;
    const content = extractJsonSectionContent(lines, scripts);
    expect(content).toContain('"build"');
    expect(content).toContain('"test"');
    expect(content).not.toContain('"express"');
  });

  it('handles empty content', () => {
    expect(parseJsonSections('')).toEqual([]);
  });

  it('handles minified JSON (single line)', () => {
    expect(parseJsonSections('{"a":1,"b":2}')).toEqual([]);
  });

  it('handles array root (no sections)', () => {
    expect(parseJsonSections('[\n  1,\n  2\n]')).toEqual([]);
  });
});

describe('findJsonSection', () => {
  it('finds section case-insensitively', () => {
    const sections = parseJsonSections(SAMPLE_JSON);
    expect(findJsonSection(sections, 'Scripts')).toBeDefined();
    expect(findJsonSection(sections, 'DEPENDENCIES')).toBeDefined();
  });

  it('returns undefined for non-existent key', () => {
    const sections = parseJsonSections(SAMPLE_JSON);
    expect(findJsonSection(sections, 'nonexistent')).toBeUndefined();
  });
});
