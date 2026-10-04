import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ContextRegistry } from '../core/context-registry.js';
import { estimateTokens } from '../core/token-estimator.js';
import { resolveSafePath } from '../core/validation.js';
import { parseMarkdownSections, findSection, extractSectionContent, duplicateSectionNote } from './markdown-sections.js';
import { parseYamlSections, findYamlSection, extractYamlSectionContent } from './yaml-sections.js';
import { parseJsonSections, findJsonSection, extractJsonSectionContent, isMinifiedJson } from './json-sections.js';
import { csvRecords, parseCsvSectionSpec, extractCsvSectionContent } from './csv-sections.js';

export interface ReadSectionArgs {
  path: string;
  heading: string;
}

export async function handleReadSection(
  args: ReadSectionArgs,
  projectRoot: string,
  contextRegistry: ContextRegistry,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const absPath = resolveSafePath(projectRoot, args.path);
  const ext = extname(absPath).toLowerCase();
  const content = await readFile(absPath, 'utf-8');
  const lines = content.split('\n');

  // Dispatch to format-specific parser
  let sectionData: { heading: string; startLine: number; endLine: number; lineCount: number; content: string; label: string } | null = null;
  let note = '';

  if (ext === '.md' || ext === '.markdown') {
    const sections = parseMarkdownSections(content);
    const section = findSection(sections, args.heading);
    if (!section) {
      return {
        content: [{
          type: 'text',
          text: `Section "${args.heading}" not found in ${args.path}.\nAvailable sections: ${sections.map(s => s.heading).join(', ')}`,
        }],
      };
    }
    const hashes = '#'.repeat(section.level);
    sectionData = { ...section, content: extractSectionContent(lines, section), label: `${hashes} ${section.heading}` };
    note = duplicateSectionNote(sections, args.heading, (s, h) => findSection([s as typeof section], h) !== undefined);
  } else if (ext === '.yaml' || ext === '.yml') {
    const sections = parseYamlSections(content);
    const section = findYamlSection(sections, args.heading);
    if (!section) {
      return {
        content: [{
          type: 'text',
          text: `Section "${args.heading}" not found in ${args.path}.\nAvailable sections: ${sections.map(s => s.heading).join(', ')}`,
        }],
      };
    }
    sectionData = { ...section, content: extractYamlSectionContent(lines, section), label: section.heading };
  } else if (ext === '.json') {
    const sections = parseJsonSections(content);
    const section = findJsonSection(sections, args.heading);
    if (!section) {
      return {
        content: [{
          type: 'text',
          text: isMinifiedJson(content)
            ? `${args.path} is minified JSON (one line), so it has no per-key sections. Use read_range or smart_read instead.`
            : `Section "${args.heading}" not found in ${args.path}.\nAvailable sections: ${sections.map(s => s.heading).join(', ')}`,
        }],
      };
    }
    sectionData = { ...section, content: extractJsonSectionContent(lines, section), label: section.heading };
  } else if (ext === '.csv') {
    const records = csvRecords(content);
    const section = parseCsvSectionSpec(args.heading, records);
    if (!section) {
      return {
        content: [{
          type: 'text',
          text: `Invalid section spec "${args.heading}" for CSV. Use format: rows:1-50 or row:5\nTotal rows: ${Math.max(0, records.length - 1)}`,
        }],
      };
    }
    sectionData = { ...section, content: extractCsvSectionContent(lines, section), label: section.heading };
  } else {
    return {
      content: [{
        type: 'text',
        text: `read_section supports: .md, .yaml, .yml, .json, .csv. Got: ${ext}`,
      }],
    };
  }

  const outputLines: string[] = [
    `FILE: ${args.path}`,
    `SECTION: ${sectionData.label} [L${sectionData.startLine}-${sectionData.endLine}] (${sectionData.lineCount} lines)`,
    ...(note ? [note] : []),
    '',
    sectionData.content,
    '',
    `HINT: Use read_for_edit("${args.path}", section="${sectionData.heading}") for edit context.`,
    'CONTEXT TRACKED.',
  ];

  const output = outputLines.join('\n');
  const tokens = estimateTokens(output);

  contextRegistry.trackLoad(absPath, {
    type: 'range',
    startLine: sectionData.startLine,
    endLine: sectionData.endLine,
    tokens,
  });

  return { content: [{ type: 'text', text: output }] };
}
