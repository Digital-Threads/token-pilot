import type { AstIndexClient } from '../ast-index/client.js';
import type { ResolvedSymbol, SymbolInfo, FileStructure, SymbolKind } from '../types.js';

export class SymbolResolver {
  private astIndex: AstIndexClient;

  constructor(astIndex: AstIndexClient) {
    this.astIndex = astIndex;
  }

  /**
   * Resolve a symbol by qualified name.
   * First tries ast-index, falls back to searching cached structure.
   */
  async resolve(qualifiedName: string, structure?: FileStructure): Promise<ResolvedSymbol | null> {
    // Try ast-index first
    const detail = await this.astIndex.symbol(qualifiedName);
    if (detail) {
      return {
        symbol: {
          name: detail.name,
          qualifiedName: detail.qualified_name,
          kind: this.mapKind(detail.kind),
          signature: detail.signature ?? detail.name,
          location: {
            startLine: detail.start_line,
            endLine: detail.end_line,
            lineCount: detail.end_line - detail.start_line + 1,
          },
          visibility: 'default',
          async: false,
          static: false,
          decorators: [],
          children: [],
          doc: null,
          references: detail.references ?? [],
        },
        filePath: detail.file,
        startLine: detail.start_line,
        endLine: detail.end_line,
      };
    }

    // Fallback: search in provided structure
    if (structure) {
      const found = this.findInStructure(qualifiedName, structure.symbols);
      if (found) {
        return {
          symbol: found,
          filePath: structure.path,
          startLine: found.location.startLine,
          endLine: found.location.endLine,
        };
      }
    }

    return null;
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

  private mapKind(kind: string): SymbolKind {
    const map: Record<string, SymbolKind> = {
      function: 'function', class: 'class', method: 'method',
      property: 'property', variable: 'variable', type: 'type',
      interface: 'interface', enum: 'enum', constant: 'constant',
      namespace: 'namespace', struct: 'class', trait: 'interface',
      impl: 'class', module: 'namespace',
    };
    return map[kind.toLowerCase()] ?? 'function';
  }

  private findInStructure(qualifiedName: string, symbols: SymbolInfo[]): SymbolInfo | null {
    const parts = qualifiedName.split('.');

    for (const sym of symbols) {
      if (parts.length === 1 && sym.name === parts[0]) {
        return sym;
      }

      if (parts.length === 2 && sym.name === parts[0]) {
        const child = sym.children.find(c => c.name === parts[1]);
        if (child) return child;
      }

      // Recurse
      const found = this.findInStructure(qualifiedName, sym.children);
      if (found) return found;
    }

    return null;
  }
}
