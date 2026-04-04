/**
 * Markdown section parser — shared helper for section-aware tools.
 * Parses heading structure with line ranges for targeted reading.
 */

export interface MarkdownSection {
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
  lineCount: number;
}

export function parseMarkdownSections(content: string): MarkdownSection[] {
  if (!content.trim()) return [];

  const lines = content.split('\n');
  const headings: Array<{ heading: string; level: number; line: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (match) {
      headings.push({
        heading: match[2].trim(),
        level: match[1].length,
        line: i + 1,
      });
    }
  }

  if (headings.length === 0) return [];

  const sections: MarkdownSection[] = [];

  for (let i = 0; i < headings.length; i++) {
    const current = headings[i];
    let endLine = lines.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= current.level) {
        endLine = headings[j].line - 1;
        break;
      }
    }

    sections.push({
      heading: current.heading,
      level: current.level,
      startLine: current.line,
      endLine,
      lineCount: endLine - current.line + 1,
    });
  }

  return sections;
}

export function findSection(sections: MarkdownSection[], heading: string): MarkdownSection | undefined {
  const normalized = heading.replace(/^#+\s*/, '').trim().toLowerCase();
  return sections.find(s => s.heading.toLowerCase() === normalized);
}

export function extractSectionContent(lines: string[], section: MarkdownSection): string {
  return lines.slice(section.startLine - 1, section.endLine).join('\n');
}
