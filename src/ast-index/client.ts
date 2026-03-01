import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FileStructure, SymbolInfo, SymbolKind, Visibility } from '../types.js';
import type {
  AstIndexOutlineEntry,
  AstIndexSymbolDetail,
  AstIndexSearchResult,
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
      const result = await this.exec(['outline', filePath, '--format', 'json']);
      const entries: AstIndexOutlineEntry[] = JSON.parse(result);
      return await this.buildFileStructure(filePath, entries);
    } catch {
      return null;
    }
  }

  async symbol(name: string): Promise<AstIndexSymbolDetail | null> {
    try {
      await this.ensureIndex();
      const result = await this.exec(['symbol', name, '--format', 'json']);
      return JSON.parse(result);
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
      return JSON.parse(result);
    } catch {
      return [];
    }
  }

  async usages(symbolName: string): Promise<AstIndexUsageResult[]> {
    await this.ensureIndex();
    try {
      const result = await this.exec(['usages', symbolName, '--format', 'json']);
      return JSON.parse(result);
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

    return {
      path: filePath,
      language: this.detectLanguage(filePath),
      meta: {
        lines: lines.length,
        bytes: fileStat.size,
        lastModified: fileStat.mtimeMs,
        contentHash: createHash('sha256').update(content).digest('hex'),
      },
      imports: [], // TODO: extract from ast-index output if available
      exports: [], // TODO: extract from ast-index output if available
      symbols: entries.map(e => this.mapOutlineEntry(e)),
    };
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
