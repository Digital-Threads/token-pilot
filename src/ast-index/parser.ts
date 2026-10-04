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
  AstIndexCallTreeNode,
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
 * ast-index ≥3.56 prints `:9-60` for a multi-line symbol and `:9` for a
 * one-line one; older versions give start lines only, and end_line is then
 * the "up to the next symbol" estimate.
 */
export function parseOutlineText(text: string): AstIndexOutlineEntry[] {
  const entries: AstIndexOutlineEntry[] = [];

  for (const line of text.split('\n')) {
    const match = line.match(/^\s*:(\d+)(?:-(\d+))?\s+(.+?)\s+\[(\w+)\]\s*$/);
    if (!match) continue;
    entries.push({
      name: match[3],
      kind: match[4],
      start_line: parseInt(match[1], 10),
      end_line: match[2] ? parseInt(match[2], 10) : 0,
    });
  }

  computeEndLines(entries);
  return entries;
}

/** Fills missing end lines: one-line symbols when the output has ranges, else an estimate. */
function computeEndLines(entries: AstIndexOutlineEntry[]): void {
  const ranged = entries.some((e) => e.end_line > 0);

  for (let i = 0; i < entries.length; i++) {
    if (entries[i].end_line > 0) continue;
    if (ranged) {
      entries[i].end_line = entries[i].start_line;
      continue;
    }
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

/** `{ a, type B, c as d }` / `def, { x }` / `* as ns` → imported names. */
function importNames(clause: string): string[] {
  return clause
    .replace(/[{}]/g, ',')
    .split(',')
    .map(s => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
    .filter(s => s.length > 0 && s !== 'type');
}

/**
 * Parse `ast-index imports` (text). Lines look like
 *   type { A, B } from './types.js';   { type C, d } from "./x";
 *   def, { named } from './m';   * as ns from 'pkg';   './side.css';
 *   x = require("./y");                      (TS/JS)
 *   from pkg.models import User, Group   import os.path    (Python)
 *   org.springframework.stereotype.Service;                (Java/Kotlin)
 * For a multi-line import the binary prints only its first line (`{`,
 * `type {`) — there is no source to read, so those are skipped.
 */
export function parseImportsText(text: string): AstIndexImportEntry[] {
  const entries: AstIndexImportEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim().replace(/;$/, '');
    if (!trimmed || trimmed.startsWith('Imports in') || trimmed.startsWith('Total:')) continue;

    // Side effect: './x.css'
    const sideEffect = trimmed.match(/^['"](.+?)['"]$/);
    if (sideEffect) {
      entries.push({ specifiers: [], source: sideEffect[1] });
      continue;
    }

    // x = require("./y")
    const req = trimmed.match(/^([\w$]+)\s*=\s*require\(\s*['"](.+?)['"]\s*\)$/);
    if (req) {
      entries.push({ specifiers: [req[1]], source: req[2], isDefault: true });
      continue;
    }

    // <clause> from 'source'
    const from = trimmed.match(/^(?:type\s+)?(.+?)\s+from\s+['"](.+?)['"]$/);
    if (from) {
      const clause = from[1];
      const ns = clause.match(/^\*\s+as\s+([\w$]+)$/);
      if (ns) {
        entries.push({ specifiers: [ns[1]], source: from[2], isNamespace: true });
      } else if (clause.startsWith('{')) {
        entries.push({ specifiers: importNames(clause), source: from[2] });
      } else {
        entries.push({ specifiers: importNames(clause), source: from[2], isDefault: true });
      }
      continue;
    }

    // Python: from pkg.mod import A, B  /  import pkg.mod
    const pyFrom = trimmed.match(/^from\s+([\w.]+)\s+import\s+(.+)$/);
    if (pyFrom) {
      entries.push({ specifiers: importNames(pyFrom[2].replace(/[()]/g, '')), source: pyFrom[1] });
      continue;
    }
    const pyImport = trimmed.match(/^import\s+([\w.]+)(?:\s+as\s+\w+)?$/);
    if (pyImport) {
      entries.push({ specifiers: [pyImport[1]], source: pyImport[1], isNamespace: true });
      continue;
    }

    // Java / Kotlin / C#-style qualified name: org.x.Service
    const qualified = trimmed.match(/^(?:static\s+)?([\w$]+(?:\.[\w$*]+)+)$/);
    if (qualified) {
      const last = qualified[1].split('.').pop()!;
      entries.push({ specifiers: [last], source: qualified[1] });
    }
  }
  return entries;
}

/**
 * Module specifiers of a JS/TS source file, read from the text itself:
 * `ast-index imports` loses the source of every multi-line import.
 * Static imports and re-exports keep their names; side-effect, dynamic
 * `import()` and `require()` have none.
 */
export function parseJsImports(text: string): AstIndexImportEntry[] {
  const entries: AstIndexImportEntry[] = [];
  const staticRe = /\b(?:import|export)\s+(?:type\s+)?([\w$*{}\s,]+?)\s*from\s*['"]([^'"\n]+)['"]/g;
  for (const m of text.matchAll(staticRe)) {
    const clause = m[1].trim();
    const ns = clause.match(/^\*\s+as\s+([\w$]+)$/);
    entries.push({ specifiers: ns ? [ns[1]] : clause === '*' ? ['*'] : importNames(clause), source: m[2] });
  }
  for (const m of text.matchAll(/\bimport\s+['"]([^'"\n]+)['"]/g)) {
    entries.push({ specifiers: [], source: m[1] });
  }
  for (const m of text.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) {
    entries.push({ specifiers: [], source: m[1] });
  }
  return entries;
}

/**
 * Parse `ast-index agrep --json` (ast-grep's JSON): one entry per match,
 * 0-based lines made 1-based; a multi-line match shows its first line and
 * its length. Falls back to the text form `file:line:source` — which prints
 * every line of a multi-line match, so it cannot count matches.
 */
export function parseAgrepText(text: string): AstIndexAgrepMatch[] {
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json)) {
      return json.map((m: { file: string; lines?: string; text?: string; range: { start: { line: number }; end: { line: number } } }) => {
        const first = (m.lines ?? m.text ?? '').split('\n')[0].trim();
        const span = m.range.end.line - m.range.start.line + 1;
        return {
          file: m.file,
          line: m.range.start.line + 1,
          text: span > 1 ? `${first} … (${span} lines)` : first,
        };
      });
    }
  } catch { /* text output */ }

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

/**
 * The grouped-block layout of `todo`, `deprecated` and `annotations`
 * (text only — `--format json` is ignored):
 *   TODO (2):                  ← group header (todo only)
 *     web/a.ts:9               ← location
 *       // TODO(alice): fix    ← the source line
 */
function parseLocationBlocks(text: string): Array<{ group?: string; file: string; line: number; source: string }> {
  const out: Array<{ group?: string; file: string; line: number; source: string }> = [];
  let group: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const header = raw.match(/^(\w+) \(\d+\):$/);
    if (header) {
      group = header[1];
      continue;
    }
    const loc = raw.match(/^ {2}(\S.*?):(\d+)$/);
    if (loc) {
      out.push({ group, file: loc[1], line: parseInt(loc[2], 10), source: '' });
      continue;
    }
    if (/^ {3,}/.test(raw) && out.length > 0 && !out[out.length - 1].source) {
      out[out.length - 1].source = line;
    }
  }
  return out;
}

export function parseTodoText(text: string): AstIndexTodoEntry[] {
  const results: AstIndexTodoEntry[] = [];
  for (const b of parseLocationBlocks(text)) {
    const kind = (b.group ?? b.source.match(/\b(TODO|FIXME|HACK|XXX)\b/i)?.[1] ?? 'TODO').toUpperCase();
    const body = b.source
      .replace(/^(\/\/+|#+|\/\*+|\*+|<!--|--)\s*/, '')
      .replace(new RegExp(`^${kind}\\b:?\\s*`, 'i'), '')
      .replace(/^:\s*/, '')
      .replace(/\s*(\*\/|-->)$/, '');
    results.push({ file: b.file, line: b.line, kind, text: body });
  }

  // Older single-line form: file:line: TODO: text
  for (const line of text.split('\n')) {
    const match = line.match(/^(\S.*?):(\d+):\s*(TODO|FIXME|HACK|XXX|NOTE|WARN(?:ING)?)[:\s]+(.*)$/i);
    if (match) {
      results.push({ file: match[1], line: parseInt(match[2], 10), kind: match[3].toUpperCase(), text: match[4].trim() });
    }
  }
  return results;
}

/** Entries have no symbol name: the binary prints only the marker line. */
export function parseDeprecatedText(text: string): AstIndexDeprecatedEntry[] {
  const results: AstIndexDeprecatedEntry[] = parseLocationBlocks(text).map(b => ({
    kind: '',
    name: '',
    file: b.file,
    line: b.line,
    message: b.source.match(/@deprecated\s+(.+?)\s*(\*\/)?$/i)?.[1] || undefined,
  }));

  // Older single-line form: kind name (file:line) - message
  for (const line of text.split('\n')) {
    const match = line.match(/^(\w+)\s+(\S+)\s+\((.+?):(\d+)\)(?:\s*-\s*(.+))?$/);
    if (match) {
      results.push({ kind: match[1], name: match[2], file: match[3], line: parseInt(match[4], 10), message: match[5]?.trim() });
    }
  }
  return results;
}

/** Entries have no symbol name: the binary prints only the annotation line. */
export function parseAnnotationsText(text: string, annotationName: string): AstIndexAnnotationEntry[] {
  const results: AstIndexAnnotationEntry[] = parseLocationBlocks(text).map(b => ({
    kind: '',
    name: '',
    file: b.file,
    line: b.line,
    annotation: annotationName,
  }));

  // Older single-line form: [@Annotation] kind name (file:line)
  for (const line of text.split('\n')) {
    const match = line.match(/^(?:@\S+\s+)?(\w+)\s+(\S+)\s+\((.+?):(\d+)\)$/);
    if (match) {
      results.push({ kind: match[1], name: match[2], file: match[3], line: parseInt(match[4], 10), annotation: annotationName });
    }
  }
  return results;
}

/**
 * Parse `ast-index call-tree` (text only — `--format json` is ignored):
 *   Call tree for 'fn':
 *     fn
 *       ← caller (src/a.ts:12)
 *         ← callerOfCaller (src/b.ts:3)
 *         ← caller (recursive)
 * Two spaces of indent per level. Null when there is no root line.
 */
export function parseCallTreeText(text: string): AstIndexCallTreeNode | null {
  let root: AstIndexCallTreeNode | null = null;
  const stack: Array<{ depth: number; node: AstIndexCallTreeNode }> = [];

  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('Call tree for')) continue;
    const depth = Math.floor((line.length - line.trimStart().length) / 2);
    const body = line.trim();

    if (!root) {
      root = { name: body, callers: [] };
      stack.push({ depth, node: root });
      continue;
    }

    const m = body.match(/^←\s+(\S+)\s+\((?:(recursive)|(.+):(\d+))\)$/);
    if (!m) continue;
    const node: AstIndexCallTreeNode = m[2]
      ? { name: m[1], recursive: true, callers: [] }
      : { name: m[1], file: m[3], line: parseInt(m[4], 10), callers: [] };

    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].node.callers!.push(node);
    stack.push({ depth, node });
  }

  return root;
}

/**
 * Parse `ast-index module <pattern>` (text only):
 *   Modules matching '%core%':
 *     core: core
 *     feature:auth: feature/auth
 *     No modules found.
 */
export function parseModuleListText(text: string): AstIndexModuleEntry[] {
  const results: AstIndexModuleEntry[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^ {2}(\S.*): (\S.*)$/);
    if (m) results.push({ name: m[1], path: m[2].trim() });
  }
  return results;
}

/**
 * Parse `ast-index deps` / `dependents` (text only):
 *   Dependencies of 'app' (2):          Modules depending on 'net' (2):
 *     implementation:                     via api (1):
 *       core (core)                         core (core)
 * The group line gives the dependency kind.
 */
export function parseModuleDepText(text: string): AstIndexModuleDep[] {
  const results: AstIndexModuleDep[] = [];
  let kind: string | undefined;
  for (const line of text.split('\n')) {
    const group = line.match(/^ {2}(?:via )?([\w-]+)(?: \(\d+\))?:$/);
    if (group) {
      kind = group[1];
      continue;
    }
    const dep = line.match(/^ {4}(\S+) \((.+)\)$/);
    if (dep) results.push({ name: dep[1], path: dep[2], type: kind });
  }
  return results;
}

/**
 * Parse `ast-index unused-deps` (text only): entries of the `=== Unused ===`
 * block, `  ✗ util (implementation)`; `(none - …)` means none.
 */
export function parseUnusedDepsText(text: string): AstIndexUnusedDep[] {
  const results: AstIndexUnusedDep[] = [];
  let inUnused = false;
  for (const line of text.split('\n')) {
    if (/^=== .* ===$/.test(line.trim())) {
      inUnused = line.includes('Unused');
      continue;
    }
    if (!inUnused) continue;
    const m = line.match(/^\s+[✗⚠!x]\s+(\S+)(?: \((.+)\))?$/);
    if (m) {
      results.push({
        name: m[1],
        path: m[1],
        reason: m[2] ? `${m[2]} dependency, no symbol used` : undefined,
      });
    }
  }
  return results;
}

/**
 * Parse `ast-index api <module>` (text only):
 *   Public API of 'core' (1):
 *     core/src/main/kotlin/c/Core.kt:3
 *       class Core { fun go() = Net().ping() }
 * Kind and name are read from the declaration line when it has a keyword.
 */
export function parseModuleApiText(text: string): AstIndexModuleApi[] {
  const results: AstIndexModuleApi[] = [];
  let pending: { file: string; line: number } | null = null;
  for (const line of text.split('\n')) {
    const loc = line.match(/^ {2}(\S.*?):(\d+)$/);
    if (loc) {
      pending = { file: loc[1], line: parseInt(loc[2], 10) };
      continue;
    }
    if (pending && /^ {4,}\S/.test(line)) {
      const signature = line.trim();
      const decl = signature.match(/\b(class|interface|object|enum|struct|trait|protocol|fun|func|function|def|fn|val|var|const|let|type|typealias)\s+([\w$]+)/);
      results.push({
        kind: decl?.[1] ?? '',
        name: decl?.[2] ?? '',
        signature,
        file: pending.file,
        line: pending.line,
      });
      pending = null;
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
