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
  let fence: { char: string; len: number } | null = null;
  let start = 0;

  // YAML front matter is not part of the document outline
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'));
    if (end > 0) start = end + 1;
  }

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      // only a fence of the same char, at least as long, with nothing after it, closes
      if (f && f[1][0] === fence.char && f[1].length >= fence.len && line.trim() === f[1]) fence = null;
      continue;
    }
    if (f) {
      fence = { char: f[1][0], len: f[1].length };
      continue;
    }

    const match = line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (match) {
      headings.push({ heading: match[2].trim(), level: match[1].length, line: i + 1 });
      continue;
    }

    // setext: a paragraph line underlined with === (h1) or --- (h2)
    const underline = line.match(/^ {0,3}(=+|-+)\s*$/);
    const prev = i > start ? lines[i - 1] : '';
    if (underline && isSetextText(prev) && headings[headings.length - 1]?.line !== i) {
      headings.push({ heading: prev.trim(), level: underline[1][0] === '=' ? 1 : 2, line: i });
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

/** Could `line` be the text of a setext heading (not blank, a list, a quote, a table or another heading)? */
function isSetextText(line: string): boolean {
  const t = line.trim();
  return t !== '' && !/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||(=+|-+)$|`{3,}|~{3,})/.test(t);
}

/** "N sections named X …" when the heading is not unique, else ''. */
export function duplicateSectionNote(sections: Array<{ heading: string; startLine: number }>, heading: string, matches: (s: { heading: string }, h: string) => boolean): string {
  const same = sections.filter((s) => matches(s, heading));
  if (same.length < 2) return '';
  return `NOTE: ${same.length} sections named "${same[0].heading}" (${same.map((s) => `L${s.startLine}`).join(', ')}); returned the first. Use read_range for another one.`;
}

export function findSection(sections: MarkdownSection[], heading: string): MarkdownSection | undefined {
  const normalized = heading.replace(/^#+\s*/, '').trim().toLowerCase();
  return sections.find(s => s.heading.toLowerCase() === normalized);
}

export function extractSectionContent(lines: string[], section: MarkdownSection): string {
  return lines.slice(section.startLine - 1, section.endLine).join('\n');
}
