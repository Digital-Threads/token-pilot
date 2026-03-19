import { relative } from 'node:path';
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

function rel(projectRoot: string, absPath: string): string {
  return relative(projectRoot, absPath) || absPath;
}

async function handlePattern(
  pattern: string,
  lang: string | undefined,
  limit: number,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<AuditResult> {
  try {
    const matches = await astIndex.agrep(pattern, { lang, limit });

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

    const lines: string[] = [
      `PATTERN SEARCH: "${pattern}"${lang ? ` (${lang})` : ''} — ${matches.length} matches in ${byFile.size} files`,
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
  const entries = await astIndex.todo();
  const limited = entries.slice(0, limit);

  if (limited.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'TODO/FIXME COMMENTS: none found.\n\nHINT: ast-index may not detect all comment formats. Try Grep with pattern "TODO|FIXME|HACK".',
      }],
      meta: { files: [] },
    };
  }

  // Group by kind
  const byKind = new Map<string, Array<{ file: string; line: number; text: string }>>();
  for (const e of limited) {
    const kind = e.kind;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push({ file: rel(projectRoot, e.file), line: e.line, text: e.text });
  }

  const lines: string[] = [
    `TODO/FIXME COMMENTS: ${limited.length} found${entries.length > limit ? ` (showing ${limit} of ${entries.length})` : ''}`,
    '',
  ];

  for (const [kind, items] of byKind) {
    lines.push(`${kind} (${items.length}):`);
    for (const item of items) {
      lines.push(`  ${item.file}:${item.line} — ${item.text}`);
    }
    lines.push('');
  }

  const todoFiles = [...new Set(limited.map(e => e.file))];
  return { content: [{ type: 'text', text: lines.join('\n') }], meta: { files: todoFiles } };
}

async function handleDeprecated(
  limit: number,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<AuditResult> {
  const entries = await astIndex.deprecated();
  const limited = entries.slice(0, limit);

  if (limited.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'DEPRECATED SYMBOLS: none found.\n\nHINT: ast-index detects @Deprecated annotations. Try Grep for other deprecation patterns.',
      }],
      meta: { files: [] },
    };
  }

  const lines: string[] = [
    `DEPRECATED SYMBOLS: ${limited.length} found${entries.length > limit ? ` (showing ${limit} of ${entries.length})` : ''}`,
    '',
  ];

  for (const e of limited) {
    const loc = `${rel(projectRoot, e.file)}:${e.line}`;
    lines.push(`  ${e.kind} ${e.name}  ${loc}${e.message ? ` — ${e.message}` : ''}`);
  }

  lines.push('');
  lines.push('HINT: Use read_symbol() to inspect deprecated symbols before removing them.');

  const depFiles = [...new Set(limited.map(e => e.file))];
  return { content: [{ type: 'text', text: lines.join('\n') }], meta: { files: depFiles } };
}

async function handleAnnotations(
  name: string,
  limit: number,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<AuditResult> {
  const entries = await astIndex.annotations(name);
  const limited = entries.slice(0, limit);

  if (limited.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `ANNOTATIONS @${name}: none found.\n\nHINT: Try Grep with pattern "@${name}" for text-based search.`,
      }],
      meta: { files: [] },
    };
  }

  // Group by file
  const byFile = new Map<string, Array<{ name: string; kind: string; line: number }>>();
  for (const e of limited) {
    const key = rel(projectRoot, e.file);
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push({ name: e.name, kind: e.kind, line: e.line });
  }

  const lines: string[] = [
    `ANNOTATIONS @${name}: ${limited.length} found in ${byFile.size} files${entries.length > limit ? ` (showing ${limit} of ${entries.length})` : ''}`,
    '',
  ];

  for (const [file, items] of byFile) {
    lines.push(`${file}:`);
    for (const item of items) {
      lines.push(`  L${item.line}: ${item.kind} ${item.name}`);
    }
    lines.push('');
  }

  const annFiles = [...new Set(limited.map(e => e.file))];
  return { content: [{ type: 'text', text: lines.join('\n') }], meta: { files: annFiles } };
}

async function handleAll(
  limit: number,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<AuditResult> {
  // Run todo + deprecated in parallel
  const [todos, deprecated] = await Promise.all([
    astIndex.todo(),
    astIndex.deprecated(),
  ]);

  const sections: string[] = ['CODE AUDIT SUMMARY', ''];

  // TODOs
  const todoLimited = todos.slice(0, limit);
  if (todoLimited.length === 0) {
    sections.push('TODO/FIXME: none found');
  } else {
    sections.push(`TODO/FIXME: ${todoLimited.length} comments${todos.length > limit ? ` (${todos.length} total)` : ''}`);
    for (const e of todoLimited) {
      sections.push(`  ${rel(projectRoot, e.file)}:${e.line} [${e.kind}] ${e.text}`);
    }
  }
  sections.push('');

  // Deprecated
  const depLimited = deprecated.slice(0, limit);
  if (depLimited.length === 0) {
    sections.push('DEPRECATED: none found');
  } else {
    sections.push(`DEPRECATED: ${depLimited.length} symbols${deprecated.length > limit ? ` (${deprecated.length} total)` : ''}`);
    for (const e of depLimited) {
      sections.push(`  ${rel(projectRoot, e.file)}:${e.line} ${e.kind} ${e.name}${e.message ? ` — ${e.message}` : ''}`);
    }
  }
  sections.push('');

  sections.push('HINT: Use code_audit(check="pattern", pattern="...") for structural pattern search (requires ast-grep).');
  sections.push('      Use Grep for text-based counting and regex search.');

  const allFiles = [...new Set([
    ...todos.slice(0, limit).map(e => e.file),
    ...deprecated.slice(0, limit).map(e => e.file),
  ])];
  return { content: [{ type: 'text', text: sections.join('\n') }], meta: { files: allFiles } };
}
