import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FileStructure, SymbolInfo, SymbolKind, Visibility } from '../types.js';
import type {
  AstIndexOutlineEntry,
  AstIndexSymbolRaw,
  AstIndexSymbolDetail,
  AstIndexSearchResponse,
  AstIndexSearchResult,
  AstIndexUsageRaw,
  AstIndexUsageResult,
  AstIndexImplementation,
  AstIndexHierarchyNode,
} from './types.js';
import { findBinary, installBinary } from './binary-manager.js';

const execFileAsync = promisify(execFile);

export class AstIndexClient {
  private binaryPath: string | null = null;
  private projectRoot: string;
  private indexed = false;
  private timeout: number;
  private configBinaryPath: string | null;
  private autoInstall: boolean;

  constructor(projectRoot: string, timeout = 5000, options?: { binaryPath?: string | null; autoInstall?: boolean }) {
    this.projectRoot = projectRoot;
    this.timeout = timeout;
    this.configBinaryPath = options?.binaryPath ?? null;
    this.autoInstall = options?.autoInstall ?? true;
  }

  async init(): Promise<void> {
    // 1. Try to find existing binary
    const status = await findBinary(this.configBinaryPath);
    if (status.available) {
      this.binaryPath = status.path;
      console.error(`[token-pilot] ast-index ${status.version} found (${status.source})`);
      return;
    }

    // 2. Auto-install if enabled
    if (this.autoInstall) {
      console.error('[token-pilot] ast-index not found, downloading...');
      try {
        const installed = await installBinary((msg) => console.error(`[token-pilot] ${msg}`));
        this.binaryPath = installed.path;
        return;
      } catch (err) {
        console.error(`[token-pilot] Auto-install failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    throw new Error(
      'ast-index binary not found and auto-install failed.\n' +
      'Install manually: npx token-pilot install-ast-index\n' +
      'Or: cargo install ast-index'
    );
  }

  async ensureIndex(): Promise<void> {
    if (this.indexed) return;
    try {
      // Try a quick command to see if index exists
      await this.exec(['stats']);
      this.indexed = true;
    } catch {
      // No index — build it
      await this.exec(['rebuild'], 60000); // 60s timeout for rebuild
      this.indexed = true;
    }
  }

  async outline(filePath: string): Promise<FileStructure | null> {
    try {
      await this.ensureIndex();
      const result = await this.exec(['outline', filePath]);
      const entries = this.parseOutlineText(result);
      if (entries.length === 0) return null;
      return await this.buildFileStructure(filePath, entries);
    } catch {
      return null;
    }
  }

  /**
   * Parse text output from `ast-index outline`:
   *   Outline of src/file.ts:
   *     :10 ClassName [class]
   *     :11 propName [property]
   *     :14 methodName [function]
   */
  private parseOutlineText(text: string): AstIndexOutlineEntry[] {
    const lines = text.split('\n');
    const entries: AstIndexOutlineEntry[] = [];
    const classStack: { entry: AstIndexOutlineEntry; indent: number }[] = [];

    for (const line of lines) {
      // Match: optional whitespace, :LINE_NUM, SYMBOL_NAME, [KIND]
      const match = line.match(/^(\s*):(\d+)\s+(\S+)\s+\[(\w+)\]/);
      if (!match) continue;

      const indent = match[1].length;
      const entry: AstIndexOutlineEntry = {
        name: match[3],
        kind: match[4],
        start_line: parseInt(match[2], 10),
        end_line: 0, // computed later
      };

      // Pop stack until we find a parent with less indent
      while (classStack.length > 0 && classStack[classStack.length - 1].indent >= indent) {
        classStack.pop();
      }

      if (classStack.length > 0) {
        // This is a child of the top of stack
        const parent = classStack[classStack.length - 1].entry;
        if (!parent.children) parent.children = [];
        parent.children.push(entry);
      } else {
        entries.push(entry);
      }

      // Push classes/interfaces onto stack as potential parents
      if (['class', 'interface', 'struct', 'enum', 'impl', 'trait', 'namespace', 'module'].includes(entry.kind.toLowerCase())) {
        classStack.push({ entry, indent });
      }
    }

    // Compute end_line for all entries
    this.computeEndLines(entries);

    return entries;
  }

  /** Compute end_line from sequential start positions */
  private computeEndLines(entries: AstIndexOutlineEntry[]): void {
    for (let i = 0; i < entries.length; i++) {
      // Children first (recursive)
      if (entries[i].children?.length) {
        this.computeEndLines(entries[i].children!);
      }

      if (i < entries.length - 1) {
        // end = next sibling's start - 1
        entries[i].end_line = entries[i + 1].start_line - 1;
      } else {
        // last entry: estimate based on children or use start + reasonable default
        const children = entries[i].children;
        if (children?.length) {
          entries[i].end_line = children[children.length - 1].end_line + 1;
        } else {
          entries[i].end_line = entries[i].start_line + 10; // estimated
        }
      }
    }
  }

  async symbol(name: string): Promise<AstIndexSymbolDetail | null> {
    try {
      await this.ensureIndex();
      const result = await this.exec(['symbol', name, '--format', 'json']);
      const raw: AstIndexSymbolRaw[] = JSON.parse(result);
      if (!Array.isArray(raw) || raw.length === 0) return null;
      const first = raw[0];
      return {
        name: first.name,
        kind: first.kind,
        file: first.path,
        start_line: first.line,
        signature: first.signature,
      };
    } catch {
      return null;
    }
  }

  async search(query: string, options?: { inFile?: string; maxResults?: number; fuzzy?: boolean }): Promise<AstIndexSearchResult[]> {
    await this.ensureIndex();
    const args = ['search', query, '--format', 'json'];
    if (options?.inFile) args.push('--in-file', options.inFile);
    if (options?.maxResults) args.push('--limit', String(options.maxResults));
    if (options?.fuzzy) args.push('--fuzzy');
    try {
      const result = await this.exec(args);
      const parsed = JSON.parse(result);
      // ast-index returns { content_matches: [...] }
      const matches = parsed.content_matches ?? parsed;
      if (!Array.isArray(matches)) return [];
      return matches.map((m: { content?: string; text?: string; line: number; path?: string; file?: string }) => ({
        file: m.path ?? m.file ?? '',
        line: m.line,
        text: m.content ?? m.text ?? '',
      }));
    } catch {
      return [];
    }
  }

  async usages(symbolName: string): Promise<AstIndexUsageResult[]> {
    await this.ensureIndex();
    try {
      const result = await this.exec(['usages', symbolName, '--format', 'json']);
      const raw: AstIndexUsageRaw[] = JSON.parse(result);
      if (!Array.isArray(raw)) return [];
      return raw.map(u => ({
        file: u.path,
        line: u.line,
        text: u.context,
        kind: 'reference',
      }));
    } catch {
      return [];
    }
  }

  async implementations(name: string): Promise<AstIndexImplementation[]> {
    await this.ensureIndex();
    try {
      const result = await this.exec(['implementations', name, '--format', 'json']);
      return JSON.parse(result);
    } catch {
      return [];
    }
  }

  async hierarchy(name: string): Promise<AstIndexHierarchyNode | null> {
    await this.ensureIndex();
    try {
      const result = await this.exec(['hierarchy', name, '--format', 'json']);
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  isAvailable(): boolean {
    return this.binaryPath !== null;
  }

  private async exec(args: string[], timeoutMs?: number): Promise<string> {
    if (!this.binaryPath) {
      throw new Error('ast-index not initialized. Call init() first.');
    }

    const { stdout } = await execFileAsync(
      this.binaryPath,
      args,
      {
        timeout: timeoutMs ?? this.timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        cwd: this.projectRoot,
      }
    );

    return stdout;
  }

  private async buildFileStructure(
    filePath: string,
    entries: AstIndexOutlineEntry[]
  ): Promise<FileStructure> {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const fileStat = await stat(filePath);

    // Fix last entry end_line to use actual file line count
    this.fixLastEndLine(entries, lines.length);

    // Enrich entries with signatures from file content
    this.enrichSignatures(entries, lines);

    return {
      path: filePath,
      language: this.detectLanguage(filePath),
      meta: {
        lines: lines.length,
        bytes: fileStat.size,
        lastModified: fileStat.mtimeMs,
        contentHash: createHash('sha256').update(content).digest('hex'),
      },
      imports: [],
      exports: [],
      symbols: entries.map(e => this.mapOutlineEntry(e)),
    };
  }

  /** Fix the last entry's end_line to use actual file line count */
  private fixLastEndLine(entries: AstIndexOutlineEntry[], totalLines: number): void {
    if (entries.length === 0) return;
    const last = entries[entries.length - 1];
    last.end_line = totalLines;
    // Recursively fix children
    if (last.children?.length) {
      this.fixLastEndLine(last.children, last.end_line - 1);
    }
  }

  /** Read actual signature lines from file content */
  private enrichSignatures(entries: AstIndexOutlineEntry[], lines: string[]): void {
    for (const entry of entries) {
      if (!entry.signature) {
        const lineIdx = entry.start_line - 1;
        if (lineIdx >= 0 && lineIdx < lines.length) {
          entry.signature = lines[lineIdx].trim();
        }
      }
      if (entry.children?.length) {
        this.enrichSignatures(entry.children, lines);
      }
    }
  }

  private mapOutlineEntry(entry: AstIndexOutlineEntry): SymbolInfo {
    return {
      name: entry.name,
      qualifiedName: entry.name, // Will be enriched with parent context
      kind: this.mapKind(entry.kind),
      signature: entry.signature ?? entry.name,
      location: {
        startLine: entry.start_line,
        endLine: entry.end_line,
        lineCount: entry.end_line - entry.start_line + 1,
      },
      visibility: this.mapVisibility(entry.visibility),
      async: entry.is_async ?? false,
      static: entry.is_static ?? false,
      decorators: entry.decorators ?? [],
      children: (entry.children ?? []).map(c => this.mapOutlineEntry(c)),
      doc: entry.doc ?? null,
      references: [],
    };
  }

  private mapKind(kind: string): SymbolKind {
    const map: Record<string, SymbolKind> = {
      function: 'function',
      class: 'class',
      method: 'method',
      property: 'property',
      variable: 'variable',
      type: 'type',
      interface: 'interface',
      enum: 'enum',
      constant: 'constant',
      namespace: 'namespace',
      struct: 'class',
      trait: 'interface',
      impl: 'class',
      module: 'namespace',
    };
    return map[kind.toLowerCase()] ?? 'function';
  }

  private mapVisibility(vis?: string): Visibility {
    if (!vis) return 'default';
    const map: Record<string, Visibility> = {
      public: 'public',
      private: 'private',
      protected: 'protected',
      pub: 'public',
      export: 'public',
    };
    return map[vis.toLowerCase()] ?? 'default';
  }

  private detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      ts: 'TypeScript', tsx: 'TypeScript',
      js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript',
      py: 'Python',
      go: 'Go',
      rs: 'Rust',
      java: 'Java',
      kt: 'Kotlin', kts: 'Kotlin',
      swift: 'Swift',
      cs: 'C#',
      cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++',
      c: 'C', h: 'C',
      php: 'PHP',
      rb: 'Ruby',
      scala: 'Scala',
      dart: 'Dart',
      lua: 'Lua',
      sh: 'Bash', bash: 'Bash',
      sql: 'SQL',
      r: 'R',
      vue: 'Vue',
      svelte: 'Svelte',
      pl: 'Perl', pm: 'Perl',
      ex: 'Elixir', exs: 'Elixir',
      groovy: 'Groovy',
      m: 'Objective-C',
      proto: 'Protocol Buffers',
      bsl: 'BSL',
    };
    return map[ext] ?? 'Unknown';
  }
}
