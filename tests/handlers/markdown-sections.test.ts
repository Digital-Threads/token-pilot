import { describe, it, expect } from 'vitest';
import { parseMarkdownSections, findSection, extractSectionContent } from '../../src/handlers/markdown-sections.js';

const SAMPLE_MD = [
  '# Title',
  '',
  'Intro paragraph.',
  '',
  '## Overview',
  'Overview text.',
  '',
  '### Details',
  'Detail text.',
  '',
  '## API Reference',
  'API intro.',
  '```ts',
  'const x = 1;',
  '```',
  '',
  '### Endpoints',
  'GET /users',
  '',
  '## Testing',
  'Test info.',
].join('\n');

describe('parseMarkdownSections', () => {
  it('parses all headings with correct line ranges', () => {
    const sections = parseMarkdownSections(SAMPLE_MD);
    expect(sections).toHaveLength(6);
    expect(sections[0]).toMatchObject({ heading: 'Title', level: 1, startLine: 1 });
    expect(sections[1]).toMatchObject({ heading: 'Overview', level: 2, startLine: 5 });
    expect(sections[2]).toMatchObject({ heading: 'Details', level: 3, startLine: 8 });
    expect(sections[3]).toMatchObject({ heading: 'API Reference', level: 2, startLine: 11 });
    expect(sections[4]).toMatchObject({ heading: 'Endpoints', level: 3, startLine: 17 });
    expect(sections[5]).toMatchObject({ heading: 'Testing', level: 2, startLine: 20 });
  });

  it('computes endLine as line before next same-or-higher-level heading', () => {
    const sections = parseMarkdownSections(SAMPLE_MD);
    const overview = sections.find(s => s.heading === 'Overview');
    expect(overview!.endLine).toBe(10);
    const details = sections.find(s => s.heading === 'Details');
    expect(details!.endLine).toBe(10);
    const testing = sections.find(s => s.heading === 'Testing');
    expect(testing!.endLine).toBe(21);
  });

  it('handles empty file', () => {
    expect(parseMarkdownSections('')).toEqual([]);
  });

  it('handles file with no headings', () => {
    expect(parseMarkdownSections('just text\nmore text')).toEqual([]);
  });
});

describe('findSection', () => {
  it('finds section by exact heading', () => {
    const sections = parseMarkdownSections(SAMPLE_MD);
    const found = findSection(sections, 'API Reference');
    expect(found).toBeDefined();
    expect(found!.startLine).toBe(11);
  });

  it('finds section case-insensitively', () => {
    const sections = parseMarkdownSections(SAMPLE_MD);
    expect(findSection(sections, 'api reference')).toBeDefined();
    expect(findSection(sections, 'API REFERENCE')).toBeDefined();
  });

  it('finds section with # prefix stripped', () => {
    const sections = parseMarkdownSections(SAMPLE_MD);
    expect(findSection(sections, '## Overview')).toBeDefined();
    expect(findSection(sections, '### Endpoints')).toBeDefined();
  });

  it('returns undefined for non-existent heading', () => {
    const sections = parseMarkdownSections(SAMPLE_MD);
    expect(findSection(sections, 'Non Existent')).toBeUndefined();
  });
});

describe('extractSectionContent', () => {
  it('extracts content for a section including heading', () => {
    const sections = parseMarkdownSections(SAMPLE_MD);
    const lines = SAMPLE_MD.split('\n');
    const testing = findSection(sections, 'Testing')!;
    const content = extractSectionContent(lines, testing);
    expect(content).toContain('## Testing');
    expect(content).toContain('Test info.');
  });

  it('does not include content from next section', () => {
    const sections = parseMarkdownSections(SAMPLE_MD);
    const lines = SAMPLE_MD.split('\n');
    const overview = findSection(sections, 'Overview')!;
    const content = extractSectionContent(lines, overview);
    expect(content).toContain('Overview text.');
    expect(content).not.toContain('API intro.');
  });
});
