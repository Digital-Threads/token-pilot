import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleReadSection } from '../../src/handlers/read-section.js';
import { ContextRegistry } from '../../src/core/context-registry.js';

describe('handleReadSection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tp-read-section-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const SAMPLE_MD = [
    '# Title',
    '',
    '## Overview',
    'Overview text here.',
    'More overview.',
    '',
    '## API Reference',
    'API content here.',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '## Testing',
    'Test content.',
  ].join('\n');

  it('returns section content by heading name', async () => {
    await writeFile(join(tempDir, 'doc.md'), SAMPLE_MD);
    const result = await handleReadSection(
      { path: 'doc.md', heading: 'API Reference' },
      tempDir,
      new ContextRegistry(),
    );
    const text = result.content[0].text;
    expect(text).toContain('SECTION: ## API Reference');
    expect(text).toContain('API content here.');
    expect(text).toContain('const x = 1;');
    expect(text).not.toContain('Test content.');
  });

  it('finds section case-insensitively', async () => {
    await writeFile(join(tempDir, 'doc.md'), SAMPLE_MD);
    const result = await handleReadSection(
      { path: 'doc.md', heading: 'api reference' },
      tempDir,
      new ContextRegistry(),
    );
    expect(result.content[0].text).toContain('API content here.');
  });

  it('returns error for non-existent heading', async () => {
    await writeFile(join(tempDir, 'doc.md'), SAMPLE_MD);
    const result = await handleReadSection(
      { path: 'doc.md', heading: 'Non Existent' },
      tempDir,
      new ContextRegistry(),
    );
    expect(result.content[0].text).toContain('not found');
  });

  it('returns error for unsupported file types', async () => {
    await writeFile(join(tempDir, 'code.ts'), 'const x = 1;');
    const result = await handleReadSection(
      { path: 'code.ts', heading: 'Overview' },
      tempDir,
      new ContextRegistry(),
    );
    expect(result.content[0].text).toContain('read_section supports');
  });

  it('tracks loaded section in contextRegistry', async () => {
    await writeFile(join(tempDir, 'doc.md'), SAMPLE_MD);
    const registry = new ContextRegistry();
    await handleReadSection({ path: 'doc.md', heading: 'Overview' }, tempDir, registry);
    expect(registry.hasAnyLoaded(join(tempDir, 'doc.md'))).toBe(true);
  });

  it('reads a YAML section by top-level key', async () => {
    const yaml = [
      'services:',
      '  web:',
      '    image: nginx',
      '',
      'volumes:',
      '  data:',
      '    driver: local',
    ].join('\n');
    await writeFile(join(tempDir, 'compose.yml'), yaml);

    const result = await handleReadSection(
      { path: 'compose.yml', heading: 'services' },
      tempDir,
      new ContextRegistry(),
    );

    const text = result.content[0].text;
    expect(text).toContain('SECTION: services');
    expect(text).toContain('image: nginx');
    expect(text).not.toContain('volumes:');
  });
});
