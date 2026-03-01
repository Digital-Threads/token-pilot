import type { AstIndexClient } from '../ast-index/client.js';
import type { ResolvedSymbol, SymbolInfo, FileStructure, SymbolKind } from '../types.js';

export class SymbolResolver {
  private astIndex: AstIndexClient;

  constructor(astIndex: AstIndexClient) {
    this.astIndex = astIndex;
  }

  /**
   * Resolve a symbol by qualified name.
   * First tries structure-based lookup, falls back to ast-index.
   */
  async resolve(qualifiedName: string, structure?: FileStructure): Promise<ResolvedSymbol | null> {
    const filePath = structure?.path;

    // 1. Try structure-based lookup first (supports Class.method and Class::method)
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

      // 1b. For qualified names like Class.method — ast-index outline is flat
      // (methods are siblings, not children of the class).
      // Try finding just the member name in the flat symbol list.
      const separator = qualifiedName.includes('::') ? '::' : qualifiedName.includes('.') ? '.' : null;
      if (separator) {
        const parts = qualifiedName.split(separator);
        const memberName = parts[parts.length - 1];
        const member = this.findFlat(memberName, structure.symbols);
        if (member) {
          return {
            symbol: member,
            filePath: structure.path,
            startLine: member.location.startLine,
            endLine: member.location.endLine,
          };
        }
      }

      // 1c. Unqualified name — search recursively in children (e.g. "run" inside a Python class)
      if (!separator) {
        const deep = this.findFlat(qualifiedName, structure.symbols);
        if (deep) {
          return {
            symbol: deep,
            filePath: structure.path,
            startLine: deep.location.startLine,
            endLine: deep.location.endLine,
          };
        }
      }
    }

    // 2. Try ast-index with full qualified name
    const detail = await this.astIndex.symbol(qualifiedName);
    if (detail && (!filePath || this.pathMatches(detail.file, filePath))) {
      let endLine = detail.start_line + 10;
      if (structure) {
        const found = this.findInStructure(qualifiedName, structure.symbols);
        if (found) endLine = found.location.endLine;
      }

      return {
        symbol: {
          name: detail.name,
          qualifiedName: qualifiedName,
          kind: this.mapKind(detail.kind),
          signature: detail.signature ?? detail.name,
          location: {
            startLine: detail.start_line,
            endLine,
            lineCount: endLine - detail.start_line + 1,
          },
          visibility: 'default',
          async: false,
          static: false,
          decorators: [],
          children: [],
          doc: null,
          references: [],
        },
        filePath: detail.file,
        startLine: detail.start_line,
        endLine,
      };
    }

    // 3. If qualified (has . or ::), try ast-index with just the leaf name
    //    Filter to requested file to avoid returning results from wrong files.
    const sep2 = qualifiedName.includes('::') ? '::' : qualifiedName.includes('.') ? '.' : null;
    if (sep2) {
      const parts = qualifiedName.split(sep2);
      const leafName = parts[parts.length - 1];
      const leafDetail = await this.astIndex.symbol(leafName);
      if (leafDetail && (!filePath || this.pathMatches(leafDetail.file, filePath))) {
        let endLine = leafDetail.start_line + 10;
        return {
          symbol: {
            name: leafDetail.name,
            qualifiedName: qualifiedName,
            kind: this.mapKind(leafDetail.kind),
            signature: leafDetail.signature ?? leafDetail.name,
            location: {
              startLine: leafDetail.start_line,
              endLine,
              lineCount: endLine - leafDetail.start_line + 1,
            },
            visibility: 'default',
            async: false,
            static: false,
            decorators: [],
            children: [],
            doc: null,
            references: [],
          },
          filePath: leafDetail.file,
          startLine: leafDetail.start_line,
          endLine,
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

  /**
   * Hierarchical search: AuthService → children → login
   */
  private findInStructure(qualifiedName: string, symbols: SymbolInfo[]): SymbolInfo | null {
    const parts = qualifiedName.includes('::')
      ? qualifiedName.split('::')
      : qualifiedName.split('.');

    return this.findByParts(parts, symbols);
  }

  private findByParts(parts: string[], symbols: SymbolInfo[]): SymbolInfo | null {
    for (const sym of symbols) {
      if (parts.length === 1 && sym.name === parts[0]) {
        return sym;
      }

      if (parts.length >= 2 && sym.name === parts[0]) {
        const found = this.findByParts(parts.slice(1), sym.children);
        if (found) return found;
      }
    }

    return null;
  }

  /**
   * Flat search by name only — searches top-level AND children recursively.
   * Used for flat outlines (TS) and for unqualified method names (Python).
   */
  private findFlat(name: string, symbols: SymbolInfo[]): SymbolInfo | null {
    for (const sym of symbols) {
      if (sym.name === name) return sym;
      if (sym.children.length > 0) {
        const found = this.findFlat(name, sym.children);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Check if two file paths refer to the same file.
   * Handles absolute vs relative paths.
   */
  private pathMatches(a: string, b: string): boolean {
    // Exact match
    if (a === b) return true;
    // One ends with the other (relative vs absolute)
    if (a.endsWith(b) || b.endsWith(a)) return true;
    // Compare basenames as last resort
    const baseA = a.split('/').pop();
    const baseB = b.split('/').pop();
    return baseA === baseB;
  }
}
