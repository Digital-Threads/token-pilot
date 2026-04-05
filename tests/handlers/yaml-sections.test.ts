import { describe, it, expect } from 'vitest';
import { parseYamlSections, findYamlSection, extractYamlSectionContent } from '../../src/handlers/yaml-sections.js';

const SAMPLE_YAML = [
  '# Docker compose config',
  'version: "3.8"',
  '',
  'services:',
  '  web:',
  '    image: nginx',
  '    ports:',
  '      - "80:80"',
  '  api:',
  '    image: node:18',
  '',
  'volumes:',
  '  data:',
  '    driver: local',
  '',
  'networks:',
  '  frontend:',
  '    driver: bridge',
].join('\n');

describe('parseYamlSections', () => {
  it('parses top-level keys with correct line ranges', () => {
    const sections = parseYamlSections(SAMPLE_YAML);
    expect(sections).toHaveLength(4);
    expect(sections[0]).toMatchObject({ heading: 'version', startLine: 2 });
    expect(sections[1]).toMatchObject({ heading: 'services', startLine: 4 });
    expect(sections[2]).toMatchObject({ heading: 'volumes', startLine: 12 });
    expect(sections[3]).toMatchObject({ heading: 'networks', startLine: 16 });
  });

  it('computes endLine correctly', () => {
    const sections = parseYamlSections(SAMPLE_YAML);
    const services = sections.find(s => s.heading === 'services');
    expect(services!.endLine).toBe(11);
    const networks = sections.find(s => s.heading === 'networks');
    expect(networks!.endLine).toBe(18);
  });

  it('handles empty content', () => {
    expect(parseYamlSections('')).toEqual([]);
  });

  it('handles comments-only content', () => {
    expect(parseYamlSections('# just a comment\n# another')).toEqual([]);
  });
});

describe('findYamlSection', () => {
  it('finds section case-insensitively', () => {
    const sections = parseYamlSections(SAMPLE_YAML);
    expect(findYamlSection(sections, 'Services')).toBeDefined();
    expect(findYamlSection(sections, 'VOLUMES')).toBeDefined();
  });

  it('strips trailing colon from query', () => {
    const sections = parseYamlSections(SAMPLE_YAML);
    expect(findYamlSection(sections, 'services:')).toBeDefined();
  });

  it('returns undefined for non-existent key', () => {
    const sections = parseYamlSections(SAMPLE_YAML);
    expect(findYamlSection(sections, 'nonexistent')).toBeUndefined();
  });
});

describe('extractYamlSectionContent', () => {
  it('extracts section content', () => {
    const sections = parseYamlSections(SAMPLE_YAML);
    const lines = SAMPLE_YAML.split('\n');
    const services = findYamlSection(sections, 'services')!;
    const content = extractYamlSectionContent(lines, services);
    expect(content).toContain('services:');
    expect(content).toContain('image: nginx');
    expect(content).toContain('image: node:18');
    expect(content).not.toContain('volumes:');
  });
});
