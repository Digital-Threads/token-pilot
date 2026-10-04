import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { AstIndexClient } from '../ast-index/client.js';
import type { CodeAuditArgs } from '../core/validation.js';

type AuditResult = { content: Array<{ type: 'text'; text: string }>; meta: { files: string[] } };

export async function handleCodeAudit(
  args: CodeAuditArgs,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<AuditResult> {
  if (astIndex.isDisabled() || astIndex.isOversized()) {
    return {
      content: [{
        type: 'text',
        text: 'ast-index is not available (project root too broad or index oversized). Use Grep/ripgrep for pattern search.',
      }],
      meta: { files: [] },
    };
  }

  const limit = args.limit ?? 50;

  switch (args.check) {
    case 'pattern':
      return handlePattern(args.pattern!, args.lang, limit, projectRoot, astIndex);
    case 'todo':
      return handleTodo(limit, projectRoot, astIndex);
    case 'deprecated':
      return handleDeprecated(limit, projectRoot, astIndex);
    case 'annotations':
      // Strip @ prefix — ast-index expects "Injectable" not "@Injectable"
      return handleAnnotations(args.name!.replace(/^@/, ''), limit, projectRoot, astIndex);
    case 'all':
      return handleAll(limit, projectRoot, astIndex);
    default:
      return {
        content: [{
          type: 'text',
          text: `Unknown check type: "${args.check}". Use: pattern, todo, deprecated, annotations, all`,
        }],
        meta: { files: [] },
      };
  }
}

/** Project-relative path; ast-index paths are relative to the project root, not to cwd. */
function rel(projectRoot: string, path: string): string {
  return relative(projectRoot, resolve(projectRoot, path)) || path;
}

const MORE = (limit: number) => `showing the first ${limit} — more may exist; raise limit to see them`;

/**
 * The declaration a marker belongs to: the first line after `line` that is
 * not blank, a comment or another annotation. ast-index prints only the
 * marker line (`@Deprecated`, `@Service`).
 */
async function declarationAt(
  projectRoot: string,
  file: string,
  line: number,
  cache: Map<string, string[] | null>,
): Promise<string> {
  if (!cache.has(file)) {
    try {
      cache.set(file, (await readFile(resolve(projectRoot, file), 'utf-8')).split('\n'));
    } catch {
      cache.set(file, null);
    }
  }
  const lines = cache.get(file);
  if (!lines) return '';

  // The marker line itself may already carry the declaration (`@Service public class X`).
  const own = lines[line - 1]?.trim().replace(/^(@[\w.]+(\([^)]*\))?\s*)+/, '') ?? '';
  if (own && !/^(\/\/|\/\*|\*)/.test(own)) return own.slice(0, 120);

  for (let i = line; i < Math.min(lines.length, line + 15); i++) {
    const t = lines[i].trim();
    if (!t || /^(@|\/\/|\/\*|\*|#)/.test(t)) continue;
    return t.slice(0, 120);
  }
  return '';
}

async function handlePattern(
  pattern: string,
  lang: string | undefined,
  limit: number,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<AuditResult> {
  try {
    const all = await astIndex.agrep(pattern, { lang, limit });
    const matches = all.slice(0, limit);

    if (matches.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `PATTERN SEARCH: "${pattern}"${lang ? ` (${lang})` : ''}\n\nNo matches found.\n\nHINT: Try Grep/ripgrep for text-based search if the pattern is not structural.`,
        }],
        meta: { files: [] },
      };
    }

    // Group by file
    const byFile = new Map<string, Array<{ line: number; text: string }>>();
    for (const m of matches) {
      const key = rel(projectRoot, m.file);
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push({ line: m.line, text: m.text });
    }

    const count = all.length > limit
      ? `showing ${limit} of ${all.length} matches (raise limit to see more)`
      : `${all.length} matches in ${byFile.size} files`;
    const lines: string[] = [
      `PATTERN SEARCH: "${pattern}"${lang ? ` (${lang})` : ''} — ${count}`,
      '',
    ];

    for (const [file, items] of byFile) {
      lines.push(`${file}:`);
      for (const item of items) {
        lines.push(`  L${item.line}: ${item.text}`);
      }
      lines.push('');
    }

    lines.push('HINT: Use read_symbol() to inspect specific matches, or Grep for text-based counting.');

    return { content: [{ type: 'text', text: lines.join('\n') }], meta: { files: [...byFile.keys()] } };
  } catch (err) {
    // ast-grep not installed — return the error message
    return {
      content: [{
        type: 'text',
        text: `PATTERN SEARCH ERROR:\n${err instanceof Error ? err.message : String(err)}\n\nFallback: Use Grep/ripgrep for text-based pattern search.`,
      }],
      meta: { files: [] },
    };
  }
}

async function handleTodo(
  limit: number,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<AuditResult> {
  const entries = await astIndex.todo(limit);

  if (entries.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'TODO/FIXME COMMENTS: none found.\n\nHINT: ast-index looks for TODO, FIXME and HACK. Try Grep for other markers.',
      }],
      meta: { files: [] },
    };
  }

  // Group by kind
  const byKind = new Map<string, Array<{ file: string; line: number; text: string }>>();
  for (const e of entries) {
    if (!byKind.has(e.kind)) byKind.set(e.kind, []);
    byKind.get(e.kind)!.push({ file: rel(projectRoot, e.file), line: e.line, text: e.text });
  }

  const lines: string[] = [
    `TODO/FIXME COMMENTS: ${entries.length} found${entries.truncated ? ` (${MORE(limit)})` : ''}`,
    '',
  ];

  for (const [kind, items] of byKind) {
    lines.push(`${kind} (${items.length}):`);
    for (const item of items) {
      lines.push(`  ${item.file}:${item.line} — ${item.text}`);
    }
    lines.push('');
  }

  const todoFiles = [...new Set(entries.map(e => rel(projectRoot, e.file)))];
  return { content: [{ type: 'text', text: lines.join('\n') }], meta: { files: todoFiles } };
}

async function handleDeprecated(
  limit: number,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<AuditResult> {
  const entries = await astIndex.deprecated(limit);

  if (entries.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'DEPRECATED SYMBOLS: none found.\n\nHINT: ast-index detects @Deprecated / @deprecated markers. Try Grep for other deprecation patterns.',
      }],
      meta: { files: [] },
    };
  }

  const lines: string[] = [
    `DEPRECATED SYMBOLS: ${entries.length} found${entries.truncated ? ` (${MORE(limit)})` : ''}`,
    '',
  ];

  const cache = new Map<string, string[] | null>();
  for (const e of entries) {
    const loc = `${rel(projectRoot, e.file)}:${e.line}`;
    const what = e.name ? `${e.kind} ${e.name}` : await declarationAt(projectRoot, e.file, e.line, cache);
    lines.push(`  ${loc}  ${what}${e.message ? ` — ${e.message}` : ''}`);
  }

  lines.push('');
  lines.push('HINT: Use read_symbol() to inspect deprecated symbols before removing them.');

  const depFiles = [...new Set(entries.map(e => rel(projectRoot, e.file)))];
  return { content: [{ type: 'text', text: lines.join('\n') }], meta: { files: depFiles } };
}

async function handleAnnotations(
  name: string,
  limit: number,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<AuditResult> {
  const entries = await astIndex.annotations(name, limit);

  if (entries.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `ANNOTATIONS @${name}: none found.\n\nHINT: Try Grep with pattern "@${name}" for text-based search.`,
      }],
      meta: { files: [] },
    };
  }

  // Group by file
  const cache = new Map<string, string[] | null>();
  const byFile = new Map<string, Array<{ line: number; what: string }>>();
  for (const e of entries) {
    const key = rel(projectRoot, e.file);
    if (!byFile.has(key)) byFile.set(key, []);
    const what = e.name ? `${e.kind} ${e.name}` : await declarationAt(projectRoot, e.file, e.line, cache);
    byFile.get(key)!.push({ line: e.line, what });
  }

  const lines: string[] = [
    `ANNOTATIONS @${name}: ${entries.length} found in ${byFile.size} files${entries.truncated ? ` (${MORE(limit)})` : ''}`,
    '',
  ];

  for (const [file, items] of byFile) {
    lines.push(`${file}:`);
    for (const item of items) {
      lines.push(`  L${item.line}: ${item.what}`);
    }
    lines.push('');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }], meta: { files: [...byFile.keys()] } };
}

async function handleAll(
  limit: number,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<AuditResult> {
  // Run todo + deprecated in parallel
  const [todos, deprecated] = await Promise.all([
    astIndex.todo(limit),
    astIndex.deprecated(limit),
  ]);

  const sections: string[] = ['CODE AUDIT SUMMARY', ''];

  if (todos.length === 0) {
    sections.push('TODO/FIXME: none found');
  } else {
    sections.push(`TODO/FIXME: ${todos.length} comments${todos.truncated ? ` (${MORE(limit)})` : ''}`);
    for (const e of todos) {
      sections.push(`  ${rel(projectRoot, e.file)}:${e.line} [${e.kind}] ${e.text}`);
    }
  }
  sections.push('');

  if (deprecated.length === 0) {
    sections.push('DEPRECATED: none found');
  } else {
    sections.push(`DEPRECATED: ${deprecated.length} symbols${deprecated.truncated ? ` (${MORE(limit)})` : ''}`);
    const cache = new Map<string, string[] | null>();
    for (const e of deprecated) {
      const what = e.name ? `${e.kind} ${e.name}` : await declarationAt(projectRoot, e.file, e.line, cache);
      sections.push(`  ${rel(projectRoot, e.file)}:${e.line} ${what}${e.message ? ` — ${e.message}` : ''}`);
    }
  }
  sections.push('');

  sections.push('HINT: Use code_audit(check="pattern", pattern="...") for structural pattern search (requires ast-grep).');
  sections.push('      Use Grep for text-based counting and regex search.');

  const allFiles = [...new Set([...todos, ...deprecated].map(e => rel(projectRoot, e.file)))];
  return { content: [{ type: 'text', text: sections.join('\n') }], meta: { files: allFiles } };
}
