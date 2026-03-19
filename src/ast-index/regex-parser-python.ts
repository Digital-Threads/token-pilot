/**
 * Regex-based fallback parser for Python.
 * Used when the ast-index binary is unavailable.
 * Extracts top-level symbols (classes, functions, variables) and class methods.
 */

import type { AstIndexOutlineEntry } from './types.js';

const PY_RESERVED = new Set([
  'if', 'else', 'elif', 'for', 'while', 'try', 'except', 'finally',
  'with', 'return', 'yield', 'raise', 'pass', 'break', 'continue',
  'import', 'from', 'as', 'del', 'assert', 'lambda', 'not', 'and', 'or',
]);

// Top-level patterns (indent 0)
const PY_CLASS_RE = /^class\s+(\w+)\s*[\(:]/ ;
const PY_FUNC_RE = /^(?:async\s+)?def\s+(\w+)\s*\(/;
const PY_ASSIGN_RE = /^([A-Z][A-Z_0-9]+)\s*[=:]/;  // MODULE_CONSTANT = ...

// Method patterns inside class body (indented 4+ spaces or 1+ tab)
const PY_METHOD_RE = /^(\s{4,}|\t+)(?:async\s+)?def\s+(\w+)\s*\(/;

// Decorator
const PY_DECORATOR_RE = /^@(\w[\w.]*)/;

export function parsePythonRegex(content: string): AstIndexOutlineEntry[] {
  const lines = content.split('\n');
  const entries: AstIndexOutlineEntry[] = [];

  let currentClass: AstIndexOutlineEntry | null = null;
  let pendingDecorators: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.match(/^(\s*)/)?.[0].length ?? 0;

    // Collect decorators
    const decMatch = trimmed.match(PY_DECORATOR_RE);
    if (decMatch) {
      pendingDecorators.push(`@${decMatch[1]}`);
      continue;
    }

    // Close current class when we hit a non-empty line at indent 0
    // that is a new definition (not a continuation)
    if (currentClass && indent === 0 && (
      PY_CLASS_RE.test(trimmed) || PY_FUNC_RE.test(trimmed) || PY_ASSIGN_RE.test(trimmed)
    )) {
      currentClass.end_line = lineNum - 1;
      currentClass = null;
    }

    // Top-level class
    if (indent === 0) {
      const classMatch = trimmed.match(PY_CLASS_RE);
      if (classMatch && !PY_RESERVED.has(classMatch[1])) {
        const entry: AstIndexOutlineEntry = {
          name: classMatch[1],
          kind: 'class',
          start_line: pendingDecorators.length > 0 ? lineNum - pendingDecorators.length : lineNum,
          end_line: 0,
          signature: trimmed.slice(0, 120),
          decorators: pendingDecorators.length > 0 ? [...pendingDecorators] : undefined,
          children: [],
        };
        entries.push(entry);
        currentClass = entry;
        pendingDecorators = [];
        continue;
      }

      // Top-level function
      const funcMatch = trimmed.match(PY_FUNC_RE);
      if (funcMatch && !PY_RESERVED.has(funcMatch[1])) {
        entries.push({
          name: funcMatch[1],
          kind: 'function',
          start_line: pendingDecorators.length > 0 ? lineNum - pendingDecorators.length : lineNum,
          end_line: 0,
          signature: trimmed.slice(0, 120),
          is_async: trimmed.startsWith('async '),
          decorators: pendingDecorators.length > 0 ? [...pendingDecorators] : undefined,
        });
        pendingDecorators = [];
        continue;
      }

      // Module-level constant
      const assignMatch = trimmed.match(PY_ASSIGN_RE);
      if (assignMatch) {
        entries.push({
          name: assignMatch[1],
          kind: 'variable',
          start_line: lineNum,
          end_line: lineNum,
          signature: trimmed.slice(0, 120),
        });
        pendingDecorators = [];
        continue;
      }
    }

    // Methods inside class body
    if (currentClass && indent >= 4) {
      const methodMatch = line.match(PY_METHOD_RE);
      if (methodMatch) {
        const name = methodMatch[2];
        if (name && !PY_RESERVED.has(name)) {
          const decoratorStart = pendingDecorators.length > 0 ? lineNum - pendingDecorators.length : lineNum;
          currentClass.children!.push({
            name,
            kind: 'method',
            start_line: decoratorStart,
            end_line: lineNum + 5,
            signature: trimmed.slice(0, 120),
            is_async: trimmed.includes('async '),
            visibility: name.startsWith('__') && name.endsWith('__') ? 'public'
              : name.startsWith('_') ? 'private' : 'public',
            decorators: pendingDecorators.length > 0 ? [...pendingDecorators] : undefined,
          });
          pendingDecorators = [];
        }
        continue;
      }
    }

    // Non-matching line resets decorators
    if (!decMatch) {
      pendingDecorators = [];
    }
  }

  // Close last class
  if (currentClass) {
    currentClass.end_line = lines.length;
  }

  // Fill in end_line for entries
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].end_line === 0) {
      entries[i].end_line = i < entries.length - 1
        ? entries[i + 1].start_line - 1
        : lines.length;
    }
  }

  return entries;
}
