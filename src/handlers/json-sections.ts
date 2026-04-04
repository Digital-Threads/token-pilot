/**
 * JSON section parser — parses top-level keys with line ranges.
 */

export interface JsonSection {
  heading: string;
  startLine: number;
  endLine: number;
  lineCount: number;
}

/**
 * Parse JSON into sections based on top-level keys.
 * Works with formatted JSON (pretty-printed). For minified JSON, returns empty.
 */
export function parseJsonSections(content: string): JsonSection[] {
  if (!content.trim()) return [];

  const lines = content.split('\n');
  if (lines.length < 3) return []; // minified or trivial

  // Find top-level keys: lines matching /^\s{0,2}"key":/ (0-2 spaces indent = top level)
  const topKeys: Array<{ key: string; line: number }> = [];

  // Track brace depth to identify top-level
  let depth = 0;
  let inString = false;
  let lineIdx = 0;

  for (lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];

    // Simple top-level key detection: at depth 1 (inside root object)
    // Match: "key": or "key" : at the beginning of a line (with indent)
    if (depth === 1) {
      const keyMatch = line.match(/^\s*"([^"]+)"\s*:/);
      if (keyMatch) {
        topKeys.push({ key: keyMatch[1], line: lineIdx + 1 });
      }
    }

    // Track depth (simplified — doesn't handle strings perfectly but good enough for formatted JSON)
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      if (ch === '"' && (ci === 0 || line[ci - 1] !== '\\')) {
        inString = !inString;
      }
      if (!inString) {
        if (ch === '{' || ch === '[') depth++;
        if (ch === '}' || ch === ']') depth--;
      }
    }
  }

  if (topKeys.length === 0) return [];

  const sections: JsonSection[] = [];
  for (let i = 0; i < topKeys.length; i++) {
    const start = topKeys[i].line;
    const end = i + 1 < topKeys.length ? topKeys[i + 1].line - 1 : lines.length - 1; // -1 to exclude closing }
    sections.push({
      heading: topKeys[i].key,
      startLine: start,
      endLine: end,
      lineCount: end - start + 1,
    });
  }

  return sections;
}

export function findJsonSection(sections: JsonSection[], heading: string): JsonSection | undefined {
  const normalized = heading.trim().toLowerCase();
  return sections.find(s => s.heading.toLowerCase() === normalized);
}

export function extractJsonSectionContent(lines: string[], section: JsonSection): string {
  return lines.slice(section.startLine - 1, section.endLine).join('\n');
}
