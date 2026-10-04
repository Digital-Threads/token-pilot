/**
 * Pure parsing functions for ast-index text/JSON output.
 * No state, no side effects — safe to import anywhere.
 */

import type { SymbolInfo, SymbolKind, Visibility } from '../types.js';
import type {
  AstIndexOutlineEntry,
  AstIndexImplementation,
  AstIndexHierarchyNode,
  AstIndexImportEntry,
  AstIndexAgrepMatch,
  AstIndexTodoEntry,
  AstIndexDeprecatedEntry,
  AstIndexAnnotationEntry,
  AstIndexModuleEntry,
  AstIndexModuleDep,
  AstIndexUnusedDep,
  AstIndexModuleApi,
} from './types.js';

export function parseFileCount(statsText: string): number {
  try {
    const json = JSON.parse(statsText);
    if (json?.stats?.file_count !== undefined) return json.stats.file_count;
  } catch { /* not JSON, fall through */ }
  const match = statsText.match(/Files:\s*(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Parse text output from `ast-index outline`:
 *   Outline of src/file.ts:
 *     :10 ClassName [class]
 *     :11 propName [property]
 *     :14 methodName [function]
 *
 * ast-index ≥3.48 prints members at the same indent as their class, so the
 * result is flat; buildFileStructure() rebuilds nesting from real ranges.
 * end_line here is only the "up to the next symbol" estimate.
 */
export function parseOutlineText(text: string): AstIndexOutlineEntry[] {
  const entries: AstIndexOutlineEntry[] = [];

  for (const line of text.split('\n')) {
    const match = line.match(/^\s*:(\d+)\s+(.+?)\s+\[(\w+)\]\s*$/);
    if (!match) continue;
    entries.push({
      name: match[2],
      kind: match[3],
      start_line: parseInt(match[1], 10),
      end_line: 0,
    });
  }

  computeEndLines(entries);
  return entries;
}

function computeEndLines(entries: AstIndexOutlineEntry[]): void {
  for (let i = 0; i < entries.length; i++) {
    entries[i].end_line = i < entries.length - 1
      ? Math.max(entries[i].start_line, entries[i + 1].start_line - 1)
      : entries[i].start_line + 10; // estimated
  }
}

export function parseImplementationsText(text: string): AstIndexImplementation[] {
  const results: AstIndexImplementation[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(class|interface|trait|struct|impl)\s+(\S+)\s+\((.+):(\d+)\)/);
    if (m) {
      results.push({ kind: m[1], name: m[2], file: m[3], line: parseInt(m[4], 10) });
    }
  }
  return results;
}

export function parseHierarchyText(text: string, rootName: string): AstIndexHierarchyNode | null {
  if (!text.trim()) return null;
  // Parse ast-index hierarchy text output:
  //   Hierarchy for 'ClassName':
  //     Parents:
  //       ParentClass (extends)
  //     Children:
  //       ChildClass (implements)  (file.ts:42)
  const lines = text.split('\n');
  const parents: AstIndexHierarchyNode[] = [];
  const childNodes: AstIndexHierarchyNode[] = [];
  let section: 'none' | 'parents' | 'children' = 'none';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'Parents:') { section = 'parents'; continue; }
    if (trimmed === 'Children:') { section = 'children'; continue; }
    if (trimmed.startsWith('Hierarchy for') || !trimmed) continue;

    // Match: SymbolName (relationship)  (file:line) — file:line is optional
    const m = trimmed.match(/^(\S+)\s+\((\w+)\)(?:\s+\((.+):(\d+)\))?/);
    if (m && section !== 'none') {
      const node: AstIndexHierarchyNode = {
        name: m[1],
        kind: m[2],
        children: [],
        file: m[3],
        line: m[4] ? parseInt(m[4], 10) : undefined,
      };
      if (section === 'parents') parents.push(node);
      else childNodes.push(node);
    }
  }

  if (parents.length === 0 && childNodes.length === 0) return null;
  return { name: rootName, kind: 'class', children: childNodes, parents };
}

export function parseImportsText(text: string): AstIndexImportEntry[] {
  const entries: AstIndexImportEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Imports in') || trimmed.startsWith('Total:')) continue;

    // Match: { X, Y } from 'source'
    const braceMatch = trimmed.match(/^\{\s*(.+?)\s*\}\s+from\s+['"](.+?)['"]/);
    if (braceMatch) {
      entries.push({ specifiers: braceMatch[1].split(',').map(s => s.trim()), source: braceMatch[2] });
      continue;
    }

    // Match: * as X from 'source'
    const nsMatch = trimmed.match(/^\*\s+as\s+(\S+)\s+from\s+['"](.+?)['"]/);
    if (nsMatch) {
      entries.push({ specifiers: [nsMatch[1]], source: nsMatch[2], isNamespace: true });
      continue;
    }

    // Match: X from 'source' (default import)
    const defaultMatch = trimmed.match(/^(\w+)\s+from\s+['"](.+?)['"]/);
    if (defaultMatch) {
      entries.push({ specifiers: [defaultMatch[1]], source: defaultMatch[2], isDefault: true });
    }
  }
  return entries;
}

export function parseAgrepText(text: string): AstIndexAgrepMatch[] {
  const results: AstIndexAgrepMatch[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // Format: file:line:matched_text  OR  file:line: matched_text
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (match) {
      results.push({ file: match[1], line: parseInt(match[2], 10), text: match[3].trim() });
    }
  }
  return results;
}

export function parseTodoText(text: string): AstIndexTodoEntry[] {
  const results: AstIndexTodoEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(/^(.+?):(\d+):\s*(TODO|FIXME|HACK|XXX|NOTE|WARN(?:ING)?)[:\s]+(.*)$/i);
    if (match) {
      results.push({ file: match[1], line: parseInt(match[2], 10), kind: match[3].toUpperCase(), text: match[4].trim() });
    }
  }
  return results;
}

export function parseDeprecatedText(text: string): AstIndexDeprecatedEntry[] {
  const results: AstIndexDeprecatedEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // Try format: kind name (file:line) - message  OR  kind name (file:line)
    const match = line.match(/^(\w+)\s+(\S+)\s+\((.+?):(\d+)\)(?:\s*-\s*(.+))?$/);
    if (match) {
      results.push({ kind: match[1], name: match[2], file: match[3], line: parseInt(match[4], 10), message: match[5]?.trim() });
    }
  }
  return results;
}

export function parseAnnotationsText(text: string, annotationName: string): AstIndexAnnotationEntry[] {
  const results: AstIndexAnnotationEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // Try format: kind name (file:line)  OR  @Annotation kind name (file:line)
    const match = line.match(/^(?:@\S+\s+)?(\w+)\s+(\S+)\s+\((.+?):(\d+)\)$/);
    if (match) {
      results.push({ kind: match[1], name: match[2], file: match[3], line: parseInt(match[4], 10), annotation: annotationName });
    }
  }
  return results;
}

export function parseModuleListText(text: string): AstIndexModuleEntry[] {
  const results: AstIndexModuleEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not JSON, parse as text */ }
    // Format: name (path) — N files  OR  name (path)  OR  path
    const match = line.match(/^(\S+)\s+\((.+?)\)(?:\s*—\s*(\d+)\s+files?)?$/);
    if (match) {
      results.push({ name: match[1], path: match[2], file_count: match[3] ? parseInt(match[3], 10) : undefined });
    } else {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('─')) {
        const name = trimmed.split('/').pop() ?? trimmed;
        results.push({ name, path: trimmed });
      }
    }
  }
  return results;
}

export function parseModuleDepText(text: string): AstIndexModuleDep[] {
  const results: AstIndexModuleDep[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not JSON, parse as text */ }
    // Format: → name (path)  OR  ← name (path)  OR  name (path)  OR  name
    const match = line.match(/^[→←\-\s]*(\S+)(?:\s+\((.+?)\))?(?:\s+\[(direct|transitive)\])?$/);
    if (match) {
      results.push({ name: match[1], path: match[2] ?? match[1], type: match[3] });
    }
  }
  return results;
}

export function parseUnusedDepsText(text: string): AstIndexUnusedDep[] {
  const results: AstIndexUnusedDep[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not JSON, parse as text */ }
    // Format: ⚠ name (path) — reason  OR  name (path)  OR  name — reason
    const match = line.match(/^[⚠!\s]*(\S+)(?:\s+\((.+?)\))?(?:\s*[—\-]+\s*(.+))?$/);
    if (match) {
      results.push({ name: match[1], path: match[2] ?? match[1], reason: match[3]?.trim() });
    }
  }
  return results;
}

export function parseModuleApiText(text: string): AstIndexModuleApi[] {
  const results: AstIndexModuleApi[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not JSON, parse as text */ }
    // Format: kind name (file:line)  OR  kind name signature (file:line)
    const match = line.match(/^(\w+)\s+(\S+)(?:\s+(.*?))?\s+\((.+?):(\d+)\)$/);
    if (match) {
      results.push({ kind: match[1], name: match[2], signature: match[3]?.trim() || undefined, file: match[4], line: parseInt(match[5], 10) });
    }
  }
  return results;
}

const KIND_MAP = new Map<string, SymbolKind>([
  ['function', 'function'], ['class', 'class'], ['method', 'method'], ['property', 'property'],
  ['variable', 'variable'], ['type', 'type'], ['interface', 'interface'], ['enum', 'enum'],
  ['constant', 'constant'], ['namespace', 'namespace'], ['struct', 'class'], ['trait', 'interface'],
  ['impl', 'class'], ['module', 'namespace'], ['package', 'namespace'],
  ['typealias', 'type'], ['type_alias', 'type'], ['typedef', 'type'], ['object', 'variable'],
  ['constructor', 'method'], ['field', 'property'], ['const', 'constant'], ['record', 'class'],
  ['protocol', 'interface'], ['extension', 'class'], ['union', 'class'],
]);

export function mapKind(kind: string): SymbolKind {
  return KIND_MAP.get(kind.toLowerCase()) ?? 'function';
}

export function mapVisibility(vis?: string): Visibility {
  if (!vis) return 'default';
  const map: Record<string, Visibility> = {
    public: 'public', private: 'private', protected: 'protected', pub: 'public', export: 'public',
  };
  return map[vis.toLowerCase()] ?? 'default';
}

export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
    js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
    py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
    swift: 'Swift', cs: 'C#', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', c: 'C', h: 'C',
    php: 'PHP', rb: 'Ruby', scala: 'Scala', dart: 'Dart', lua: 'Lua',
    sh: 'Bash', bash: 'Bash', sql: 'SQL', r: 'R', vue: 'Vue', svelte: 'Svelte',
    pl: 'Perl', pm: 'Perl', ex: 'Elixir', exs: 'Elixir', groovy: 'Groovy',
    m: 'Objective-C', proto: 'Protocol Buffers', bsl: 'BSL',
  };
  return map[ext] ?? 'Unknown';
}

export function mapOutlineEntry(entry: AstIndexOutlineEntry): SymbolInfo {
  return {
    name: entry.name,
    qualifiedName: entry.name,
    kind: mapKind(entry.kind),
    signature: entry.signature ?? entry.name,
    location: {
      startLine: entry.start_line,
      endLine: entry.end_line,
      lineCount: entry.end_line - entry.start_line + 1,
    },
    visibility: mapVisibility(entry.visibility),
    async: entry.is_async ?? false,
    static: entry.is_static ?? false,
    decorators: entry.decorators ?? [],
    children: (entry.children ?? []).map(c => mapOutlineEntry(c)),
    doc: entry.doc ?? null,
    references: [],
  };
}
