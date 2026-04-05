/**
 * YAML section parser — parses top-level keys with line ranges.
 */

export interface YamlSection {
  heading: string;
  startLine: number;
  endLine: number;
  lineCount: number;
}

/**
 * Parse YAML into sections based on top-level keys.
 * A top-level key is a key at indent level 0.
 */
export function parseYamlSections(content: string): YamlSection[] {
  if (!content.trim()) return [];

  const lines = content.split('\n');
  const topKeys: Array<{ key: string; line: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments and empty lines
    if (!line.trim() || line.trim().startsWith('#')) continue;
    // Top-level key: starts at column 0, has format "key:" or "key: value"
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_.-]*):/);
    if (match) {
      topKeys.push({ key: match[1], line: i + 1 });
    }
  }

  if (topKeys.length === 0) return [];

  const sections: YamlSection[] = [];
  for (let i = 0; i < topKeys.length; i++) {
    const start = topKeys[i].line;
    const end = i + 1 < topKeys.length ? topKeys[i + 1].line - 1 : lines.length;
    sections.push({
      heading: topKeys[i].key,
      startLine: start,
      endLine: end,
      lineCount: end - start + 1,
    });
  }

  return sections;
}

export function findYamlSection(sections: YamlSection[], heading: string): YamlSection | undefined {
  const normalized = heading.trim().toLowerCase().replace(/:$/, '');
  return sections.find(s => s.heading.toLowerCase() === normalized);
}

export function extractYamlSectionContent(lines: string[], section: YamlSection): string {
  return lines.slice(section.startLine - 1, section.endLine).join('\n');
}
