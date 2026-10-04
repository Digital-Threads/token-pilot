import type { AstIndexClient } from '../ast-index/client.js';
import type { ResolvedSymbol, SymbolInfo, FileStructure } from '../types.js';
import { buildFileStructure } from '../ast-index/enricher.js';

export class SymbolResolver {
  private astIndex: AstIndexClient;

  constructor(astIndex: AstIndexClient) {
    this.astIndex = astIndex;
  }

  /**
   * Resolve a symbol (`name`, `Class.method`, `Class::method`) in one file.
   *
   * The file's structure is authoritative when it has symbols. Without one,
   * ast-index's symbol index is asked, but only a hit in that same file
   * counts, and its end line is read from the source — never guessed.
   */
  async resolve(
    qualifiedName: string,
    structure?: FileStructure,
    filePath?: string,
  ): Promise<ResolvedSymbol | null> {
    if (structure && structure.symbols.length > 0) {
      const found = this.pick(this.findAll(qualifiedName, structure));
      return found ? toResolved(found, structure.path) : null;
    }

    const file = structure?.path ?? filePath;
    if (!file || splitName(qualifiedName).length > 1) return null; // can't check the class without a structure

    const detail = await this.astIndex.symbol(qualifiedName);
    if (!detail || !this.pathMatches(detail.file, file)) return null;

    const built = await buildFileStructure(file, [
      { name: detail.name, kind: detail.kind, start_line: detail.start_line, end_line: 0 },
    ]).catch(() => null);
    const sym = built && this.pick(
      findDeep(built.symbols, (s) => s.name === detail.name)
        .filter((s) => s.location.startLine <= detail.start_line && detail.start_line <= s.location.endLine),
    );
    return sym ? toResolved(sym, file) : null;
  }

  /** Every symbol in the structure that `qualifiedName` names, in document order. */
  findAll(qualifiedName: string, structure?: FileStructure): SymbolInfo[] {
    if (!structure) return [];
    const parts = splitName(qualifiedName);
    const last = parts[parts.length - 1];

    const byPath = parts.length === 1
      ? findDeep(structure.symbols, (s) => s.name === last)
      : findDeep(structure.symbols, (s) => s.name === parts[0])
        .flatMap((head) => this.descend(parts.slice(1), head.children));
    // Go methods are top-level with qualifiedName Receiver.Method
    const byQualified = findDeep(structure.symbols, (s) => s.qualifiedName === qualifiedName.replace(/::/g, '.'));

    const seen = new Set<SymbolInfo>();
    return [...byPath, ...byQualified]
      .filter((s) => (seen.has(s) ? false : (seen.add(s), true)))
      .sort((a, b) => a.location.startLine - b.location.startLine);
  }

  /**
   * Extract source code for a resolved symbol from file lines.
   */
  extractSource(
    resolved: ResolvedSymbol,
    lines: string[],
    options: { contextBefore?: number; contextAfter?: number } = {}
  ): string {
    const { contextBefore = 2, contextAfter = 0 } = options;

    const start = Math.max(0, resolved.startLine - 1 - contextBefore);
    const end = Math.min(lines.length, resolved.endLine + contextAfter);

    const output: string[] = [];
    for (let i = start; i < end; i++) {
      const lineNum = String(i + 1).padStart(4);
      output.push(`${lineNum} | ${lines[i]}`);
    }

    return output.join('\n');
  }

  private descend(parts: string[], symbols: SymbolInfo[]): SymbolInfo[] {
    const hits = symbols.filter((s) => s.name === parts[0]);
    return parts.length === 1 ? hits : hits.flatMap((h) => this.descend(parts.slice(1), h.children));
  }

  /** Same-name symbols: prefer a declaration over a package/namespace line. */
  private pick(candidates: SymbolInfo[]): SymbolInfo | null {
    return candidates.find((s) => s.kind !== 'namespace') ?? candidates[0] ?? null;
  }

  /** Same file? Absolute vs relative paths match only on a path-separator boundary. */
  private pathMatches(a: string, b: string): boolean {
    return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
  }
}

function splitName(qualifiedName: string): string[] {
  return qualifiedName.includes('::') ? qualifiedName.split('::') : qualifiedName.split('.');
}

function findDeep(symbols: SymbolInfo[], test: (s: SymbolInfo) => boolean): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  const walk = (list: SymbolInfo[]): void => {
    for (const s of list) {
      if (test(s)) out.push(s);
      walk(s.children);
    }
  };
  walk(symbols);
  return out;
}

function toResolved(symbol: SymbolInfo, filePath: string): ResolvedSymbol {
  return {
    symbol,
    filePath,
    startLine: symbol.location.startLine,
    endLine: symbol.location.endLine,
  };
}
