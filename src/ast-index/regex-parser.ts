/**
 * Regex-based fallback parser for TypeScript/JavaScript.
 * Used when the ast-index binary is unavailable.
 * Extracts top-level symbols and class/interface members.
 */

import type { AstIndexOutlineEntry } from './types.js';

const RESERVED = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'return', 'throw', 'try', 'catch',
  'const', 'let', 'var', 'import', 'export', 'default', 'new', 'typeof', 'instanceof',
  'await', 'yield', 'delete', 'void', 'in', 'of', 'case', 'break', 'continue',
]);

// Top-level declaration patterns (matched against trimmed line at indent 0)
const TOP_LEVEL: Array<{ re: RegExp; kind: string }> = [
  { re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
  { re: /^(?:export\s+)?interface\s+(\w+)/, kind: 'interface' },
  { re: /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+(\w+)/, kind: 'enum' },
  { re: /^(?:export\s+)?type\s+(\w+)\s*[=<]/, kind: 'type' },
  { re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/, kind: 'function' },
  // const/let arrow or function expression: export const foo = (async)? (fn | arrow)
  { re: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=\n]+)?\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>|\w+\s*=>|<)/, kind: 'function' },
];

// Method pattern inside class/interface body (indented 2+ spaces)
const METHOD_RE = /^(\s{2,})(?:(?:public|private|protected|static|abstract|override|readonly|async)\s+)*(?:get\s+|set\s+)?(\w+)\s*(?:<[^(]*>)?\s*\(/;

export function parseTypeScriptRegex(content: string): AstIndexOutlineEntry[] {
  const lines = content.split('\n');
  const entries: AstIndexOutlineEntry[] = [];

  // Track which class/interface we're currently inside using brace depth
  let braceDepth = 0;
  let currentClass: AstIndexOutlineEntry | null = null;
  let classOpenDepth = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (!trimmed) continue;

    // Count brace changes on this line (skip strings/comments roughly)
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '/' && line[j + 1] === '/') break;  // line comment
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
    }

    // Close current class when we return to its opening depth
    if (currentClass && braceDepth <= classOpenDepth) {
      currentClass.end_line = lineNum;
      currentClass = null;
      classOpenDepth = -1;
    }

    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;

    // Top-level declarations (indent 0 only)
    if (indent === 0) {
      let hit = false;
      for (const p of TOP_LEVEL) {
        const m = trimmed.match(p.re);
        if (!m) continue;
        const name = m[1];
        if (!name || RESERVED.has(name)) continue;

        const entry: AstIndexOutlineEntry = {
          name,
          kind: p.kind,
          start_line: lineNum,
          end_line: 0,
          signature: trimmed.slice(0, 120),
          children: p.kind === 'class' || p.kind === 'interface' || p.kind === 'enum' ? [] : undefined,
        };

        entries.push(entry);

        if (entry.children !== undefined) {
          currentClass = entry;
          // Class opens on this line — brace depth after counting this line
          classOpenDepth = braceDepth - 1;
        }

        hit = true;
        break;
      }
      if (hit) continue;
    }

    // Method declarations inside class/interface body
    if (currentClass && indent >= 2) {
      const m = line.match(METHOD_RE);
      if (m) {
        const name = m[2];
        if (name && !RESERVED.has(name)) {
          // Exclude arrow assignments (those have = before the ()
          // and plain function calls like this.foo() or obj.method()
          const beforeParen = line.indexOf('(');
          const segment = line.slice(0, beforeParen);
          if (!segment.includes('.') && !segment.includes('=')) {
            currentClass.children!.push({
              name,
              kind: 'method',
              start_line: lineNum,
              end_line: lineNum + 5,
              signature: trimmed.slice(0, 120),
            });
          }
        }
      }
    }
  }

  // Fill in end_line for top-level entries that didn't close via brace tracking
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].end_line === 0) {
      entries[i].end_line = i < entries.length - 1
        ? entries[i + 1].start_line - 1
        : lines.length;
    }
  }

  return entries;
}
