import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ContextRegistry } from '../core/context-registry.js';
import { estimateTokens } from '../core/token-estimator.js';
import { resolveSafePath } from '../core/validation.js';
import { parseMarkdownSections, findSection, extractSectionContent } from './markdown-sections.js';

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

  if (ext !== '.md' && ext !== '.markdown') {
    return {
      content: [{
        type: 'text',
        text: `read_section only works with Markdown files (.md, .markdown). Got: ${ext}`,
      }],
    };
  }

  const content = await readFile(absPath, 'utf-8');
  const lines = content.split('\n');
  const sections = parseMarkdownSections(content);
  const section = findSection(sections, args.heading);

  if (!section) {
    const available = sections.map(s => s.heading).join(', ');
    return {
      content: [{
        type: 'text',
        text: `Section "${args.heading}" not found in ${args.path}.\nAvailable sections: ${available}`,
      }],
    };
  }

  const sectionContent = extractSectionContent(lines, section);
  const hashes = '#'.repeat(section.level);

  const outputLines: string[] = [
    `FILE: ${args.path}`,
    `SECTION: ${hashes} ${section.heading} [L${section.startLine}-${section.endLine}] (${section.lineCount} lines)`,
    '',
    sectionContent,
    '',
    `HINT: Use read_for_edit("${args.path}", section="${section.heading}") for edit context.`,
    'CONTEXT TRACKED.',
  ];

  const output = outputLines.join('\n');
  const tokens = estimateTokens(output);

  contextRegistry.trackLoad(absPath, {
    type: 'range',
    startLine: section.startLine,
    endLine: section.endLine,
    tokens,
  });

  return { content: [{ type: 'text', text: output }] };
}
