/**
 * File structure enrichment functions.
 * Reads file content and adds Python/PHP method extraction, signatures, etc.
 */

import { stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { FileStructure } from '../types.js';
import type { AstIndexOutlineEntry } from './types.js';
import { detectLanguage, mapOutlineEntry } from './parser.js';

export async function buildFileStructure(
  filePath: string,
  entries: AstIndexOutlineEntry[],
): Promise<FileStructure> {
  const content = await readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  const fileStat = await stat(filePath);

  fixLastEndLine(entries, lines.length);

  const lang = detectLanguage(filePath);
  if (lang === 'Python') {
    enrichPythonClassMethods(entries, lines);
  } else if (lang === 'PHP') {
    enrichPHPClassMethods(entries, lines);
  }

  enrichSignatures(entries, lines);

  return {
    path: filePath,
    language: lang,
    meta: {
      lines: lines.length,
      bytes: fileStat.size,
      lastModified: fileStat.mtimeMs,
      contentHash: createHash('sha256').update(content).digest('hex'),
    },
    imports: [],
    exports: [],
    symbols: entries.map(e => mapOutlineEntry(e)),
  };
}

/**
 * Python: ast-index doesn't return methods inside classes.
 * Parse file content to extract `def` methods for classes without children.
 */
function enrichPythonClassMethods(entries: AstIndexOutlineEntry[], lines: string[]): void {
  for (const entry of entries) {
    if (entry.kind.toLowerCase() !== 'class') continue;
    if (entry.children && entry.children.length > 0) continue;

    const classStartIdx = entry.start_line - 1; // 0-based
    const classEndIdx = entry.end_line - 1;

    // Detect class body indent: look for first `def ` inside class range
    let bodyIndent = -1;
    for (let i = classStartIdx + 1; i <= classEndIdx && i < lines.length; i++) {
      const defMatch = lines[i].match(/^(\s+)def\s/);
      if (defMatch) {
        bodyIndent = defMatch[1].length;
        break;
      }
    }
    if (bodyIndent < 0) continue; // no methods found

    const methods: AstIndexOutlineEntry[] = [];

    for (let i = classStartIdx + 1; i <= classEndIdx && i < lines.length; i++) {
      const line = lines[i];
      // Match `def method_name(` at the detected indent level
      const match = line.match(new RegExp(`^\\s{${bodyIndent}}def\\s+(\\w+)\\s*\\(`));
      if (!match) continue;

      const methodName = match[1];
      const methodLine = i + 1; // 1-based

      const isAsync = line.includes('async def');
      const isStatic = i > 0 && /^\s*@staticmethod/.test(lines[i - 1]);
      const isClassMethod = i > 0 && /^\s*@classmethod/.test(lines[i - 1]);

      // Collect decorators above
      const decorators: string[] = [];
      for (let d = i - 1; d >= classStartIdx; d--) {
        const decMatch = lines[d].match(new RegExp(`^\\s{${bodyIndent}}@(\\w+)`));
        if (decMatch) {
          decorators.unshift(`@${decMatch[1]}`);
        } else {
          break;
        }
      }

      // Determine visibility from name
      const visibility = methodName.startsWith('__') && !methodName.endsWith('__')
        ? 'private'
        : methodName.startsWith('_')
          ? 'protected'
          : 'public';

      methods.push({
        name: methodName,
        kind: isStatic || isClassMethod ? 'function' : 'method',
        start_line: methodLine,
        end_line: 0, // computed below
        signature: line.trim(),
        visibility,
        is_async: isAsync,
        is_static: isStatic,
        decorators: decorators.length > 0 ? decorators : undefined,
      });
    }

    // Compute end_lines for methods
    for (let m = 0; m < methods.length; m++) {
      if (m < methods.length - 1) {
        const nextStart = methods[m + 1].start_line;
        let endLine = nextStart - 1;
        for (let k = nextStart - 2; k >= methods[m].start_line; k--) {
          const l = lines[k];
          if (l.trim() === '' || new RegExp(`^\\s{${bodyIndent}}@`).test(l)) {
            endLine = k;
          } else {
            break;
          }
        }
        methods[m].end_line = endLine;
      } else {
        methods[m].end_line = entry.end_line;
      }
    }

    entry.children = methods;
  }
}

/**
 * PHP: ast-index doesn't return methods inside classes.
 * Parse file content to extract `function` methods for classes without children.
 */
function enrichPHPClassMethods(entries: AstIndexOutlineEntry[], lines: string[]): void {
  for (const entry of entries) {
    if (entry.kind.toLowerCase() !== 'class') continue;
    if (entry.children && entry.children.length > 0) continue;

    const classStartIdx = entry.start_line - 1;
    const classEndIdx = entry.end_line - 1;

    // Detect class body indent: look for first `function ` inside class range
    let bodyIndent = -1;
    for (let i = classStartIdx + 1; i <= classEndIdx && i < lines.length; i++) {
      const fnMatch = lines[i].match(/^(\s+)(?:public|private|protected|static|\s)*function\s/);
      if (fnMatch) {
        bodyIndent = fnMatch[1].length;
        break;
      }
    }
    if (bodyIndent < 0) continue;

    const methods: AstIndexOutlineEntry[] = [];

    for (let i = classStartIdx + 1; i <= classEndIdx && i < lines.length; i++) {
      const line = lines[i];
      // Match PHP method: [visibility] [static] function name(
      const match = line.match(
        new RegExp(`^\\s{${bodyIndent}}(?:(public|private|protected)\\s+)?(?:(static)\\s+)?function\\s+(\\w+)\\s*\\(`)
      );
      if (!match) continue;

      const visibility = match[1] ?? 'public';
      const isStatic = !!match[2];
      const methodName = match[3];
      const methodLine = i + 1;

      methods.push({
        name: methodName,
        kind: isStatic ? 'function' : 'method',
        start_line: methodLine,
        end_line: 0,
        signature: line.trim(),
        visibility,
        is_static: isStatic,
      });
    }

    // Compute end_lines
    for (let m = 0; m < methods.length; m++) {
      if (m < methods.length - 1) {
        methods[m].end_line = methods[m + 1].start_line - 1;
      } else {
        methods[m].end_line = entry.end_line;
      }
    }

    entry.children = methods;
  }
}

/** Fix the last entry's end_line to use actual file line count */
export function fixLastEndLine(entries: AstIndexOutlineEntry[], totalLines: number): void {
  if (entries.length === 0) return;
  const last = entries[entries.length - 1];
  last.end_line = totalLines;
  if (last.children?.length) {
    fixLastEndLine(last.children, last.end_line - 1);
  }
}

/** Read actual signature lines from file content */
function enrichSignatures(entries: AstIndexOutlineEntry[], lines: string[]): void {
  for (const entry of entries) {
    if (!entry.signature) {
      const lineIdx = entry.start_line - 1;
      if (lineIdx >= 0 && lineIdx < lines.length) {
        entry.signature = lines[lineIdx].trim();
      }
    }
    if (entry.children?.length) {
      enrichSignatures(entry.children, lines);
    }
  }
}
