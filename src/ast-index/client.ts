import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FileStructure, SymbolInfo } from '../types.js';
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
  AstIndexRefsResponse,
  AstIndexRefEntry,
  AstIndexMapResponse,
  AstIndexConventionsResponse,
  AstIndexCallerEntry,
  AstIndexCallTreeNode,
  AstIndexChangedEntry,
  AstIndexUnusedSymbol,
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
import { findBinary, installBinary } from './binary-manager.js';
import {
  parseFileCount,
  parseOutlineText,
  parseImportsText,
  parseImplementationsText,
  parseHierarchyText,
  parseAgrepText,
  parseTodoText,
  parseDeprecatedText,
  parseAnnotationsText,
  parseModuleListText,
  parseModuleDepText,
  parseUnusedDepsText,
  parseModuleApiText,
  mapKind,
  mapVisibility,
  detectLanguage,
} from './parser.js';
import { buildFileStructure } from './enricher.js';

const execFileAsync = promisify(execFile);

export class AstIndexClient {
  private static readonly MAX_INDEX_FILES = 50_000;

  private binaryPath: string | null = null;
  private projectRoot: string;
  private indexed = false;
  private indexOversized = false;
  private indexDisabled = false;
  private indexPromise: Promise<void> | null = null;
  private timeout: number;
  private configBinaryPath: string | null;
  private autoInstall: boolean;
  private astGrepAvailable: boolean | null = null;
  private astGrepBinDir: string | null = null;

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

    if (this.indexDisabled) {
      throw new Error(
        'ast-index: index build disabled — project root is too broad (e.g. /). ' +
        'Configure mcpServers with "args": ["/path/to/project"] to set the correct project root.'
      );
    }

    if (this.indexOversized) {
      throw new Error(
        'ast-index disabled: previous build indexed >50k files (likely node_modules). ' +
        'Ensure node_modules is in .gitignore, then restart the MCP server.'
      );
    }

    // Deduplicate concurrent calls — all waiters share one build
    if (this.indexPromise) return this.indexPromise;

    this.indexPromise = this.buildIndex();
    try {
      await this.indexPromise;
    } finally {
      this.indexPromise = null;
    }
  }

  private async buildIndex(): Promise<void> {
    let existingFileCount = 0;
    try {
      const stats = await this.exec(['--format', 'json', 'stats']);
      existingFileCount = parseFileCount(stats);
    } catch { /* no index yet */ }

    if (existingFileCount > AstIndexClient.MAX_INDEX_FILES) {
      console.error(`[token-pilot] ast-index: existing index has ${existingFileCount} files (>${AstIndexClient.MAX_INDEX_FILES}) — likely includes node_modules. Clearing.`);
      try { await this.exec(['clear']); } catch { /* best effort */ }
      existingFileCount = 0;
    }

    if (existingFileCount > 0) {
      console.error(`[token-pilot] ast-index: updating index (${existingFileCount} files)...`);
      try {
        await this.exec(['update'], 30000);
        try {
          existingFileCount = parseFileCount(await this.exec(['--format', 'json', 'stats']));
        } catch { /* keep previous count */ }

        if (existingFileCount > AstIndexClient.MAX_INDEX_FILES) {
          return this.handleOversizedIndex(existingFileCount);
        }

        this.indexed = true;
        console.error(`[token-pilot] ast-index: index ready (${existingFileCount} files)`);
        return;
      } catch (updateErr) {
        console.error(`[token-pilot] ast-index: update failed, falling back to rebuild — ${updateErr instanceof Error ? updateErr.message : updateErr}`);
      }
    }

    console.error('[token-pilot] ast-index: building index (this may take a moment)...');
    try {
      await this.exec(['rebuild'], 120000);

      const fileCount = parseFileCount(await this.exec(['--format', 'json', 'stats']).catch(() => ''));

      if (fileCount > AstIndexClient.MAX_INDEX_FILES) {
        return this.handleOversizedIndex(fileCount);
      }

      this.indexed = true;
      console.error(`[token-pilot] ast-index: index built (${fileCount} files)`);
    } catch (buildErr) {
      const errMsg = buildErr instanceof Error ? buildErr.message : String(buildErr);
      if (errMsg.includes('lock') || errMsg.includes('already running')) {
        const count = parseFileCount(await this.exec(['--format', 'json', 'stats']).catch(() => ''));
        if (count > 0 && count <= AstIndexClient.MAX_INDEX_FILES) {
          this.indexed = true;
          console.error(`[token-pilot] ast-index: using existing index (${count} files, rebuild skipped due to lock)`);
          return;
        }
        if (count > AstIndexClient.MAX_INDEX_FILES) {
          return this.handleOversizedIndex(count);
        }
      }
      console.error(`[token-pilot] ast-index: rebuild failed — ${errMsg}`);
      throw buildErr;
    }
  }

  private async handleOversizedIndex(fileCount: number): Promise<void> {
    this.indexOversized = true;
    this.indexed = false;
    try { await this.exec(['clear']); } catch { /* best effort */ }
    console.error(
      `[token-pilot] ast-index: ${fileCount} files indexed (>${AstIndexClient.MAX_INDEX_FILES}) — ` +
      `likely includes node_modules. Index cleared.\n` +
      `  → Ensure node_modules is in .gitignore\n` +
      `  → Tools disabled: find_unused, find_usages, related_files, project_overview\n` +
      `  → Tools still working: outline, smart_read, smart_read_many, read_symbol`
    );
  }

  async outline(filePath: string): Promise<FileStructure | null> {
    try {
      const result = await this.exec(['outline', filePath]);
      const entries = parseOutlineText(result);
      if (entries.length === 0) return null;
      return await buildFileStructure(filePath, entries);
    } catch {
      if (this.indexDisabled || this.indexOversized) return null;
      try {
        await this.ensureIndex();
        const result = await this.exec(['outline', filePath]);
        const entries = parseOutlineText(result);
        if (entries.length === 0) return null;
        return await buildFileStructure(filePath, entries);
      } catch (err) {
        console.error(`[token-pilot] ast-index outline failed for ${filePath}: ${err instanceof Error ? err.message : err}`);
        return null;
      }
    }
  }

  async symbol(name: string): Promise<AstIndexSymbolDetail | null> {
    try {
      const result = await this.exec(['symbol', name, '--format', 'json']);
      const raw: AstIndexSymbolRaw[] = JSON.parse(result);
      if (Array.isArray(raw) && raw.length > 0) {
        const first = raw[0];
        return { name: first.name, kind: first.kind, file: first.path, start_line: first.line, signature: first.signature };
      }
    } catch { /* fall through to ensureIndex path */ }

    if (this.indexDisabled || this.indexOversized) return null;
    try {
      await this.ensureIndex();
      const result = await this.exec(['symbol', name, '--format', 'json']);
      const raw: AstIndexSymbolRaw[] = JSON.parse(result);
      if (!Array.isArray(raw) || raw.length === 0) return null;
      const first = raw[0];
      return { name: first.name, kind: first.kind, file: first.path, start_line: first.line, signature: first.signature };
    } catch (err) {
      console.error(`[token-pilot] ast-index symbol failed: ${err instanceof Error ? err.message : err}`);
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
      // ast-index returns { content_matches: [], symbols: [], files: [], references: [] }
      // Merge all result types — content_matches alone is often empty
      const all: Array<{ path?: string; file?: string; line: number; content?: string; text?: string; signature?: string }> = [
        ...(Array.isArray(parsed.content_matches) ? parsed.content_matches : []),
        ...(Array.isArray(parsed.symbols) ? parsed.symbols.map((s: { path?: string; file?: string; line: number; signature?: string; name?: string }) => ({
          path: s.path ?? s.file, line: s.line, content: s.signature ?? s.name,
        })) : []),
        ...(Array.isArray(parsed.files) ? parsed.files.map((f: { path?: string; file?: string; line?: number }) => ({
          path: f.path ?? f.file, line: f.line ?? 1, content: f.path ?? f.file,
        })) : []),
        ...(Array.isArray(parsed.references) ? parsed.references : []),
      ];
      const matches = all.length > 0 ? all : (Array.isArray(parsed) ? parsed : []);
      const mapped = matches
        .map((m: { content?: string; text?: string; signature?: string; line?: number; path?: string; file?: string }) => ({
          file: m.path ?? m.file ?? '',
          line: typeof m.line === 'number' ? m.line : 0,
          text: m.content ?? m.text ?? m.signature ?? '',
        }))
        .filter(r => r.file !== '' && r.text !== '');

      // Deduplicate by file:line
      const seen = new Set<string>();
      return mapped.filter(r => {
        const key = `${r.file}:${r.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch (err) {
      console.error(`[token-pilot] ast-index search failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async usages(symbolName: string): Promise<AstIndexUsageResult[]> {
    await this.ensureIndex();
    try {
      const result = await this.exec(['usages', symbolName, '--format', 'json']);
      const raw: AstIndexUsageRaw[] = JSON.parse(result);
      if (!Array.isArray(raw)) return [];
      return raw.map(u => ({ file: u.path, line: u.line, text: u.context, kind: 'reference' }));
    } catch (err) {
      console.error(`[token-pilot] ast-index usages failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async implementations(name: string): Promise<AstIndexImplementation[]> {
    await this.ensureIndex();
    try {
      const result = await this.exec(['implementations', name, '--format', 'json']);
      try {
        return JSON.parse(result);
      } catch {
        return parseImplementationsText(result);
      }
    } catch (err) {
      console.error(`[token-pilot] ast-index implementations failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async hierarchy(name: string): Promise<AstIndexHierarchyNode | null> {
    await this.ensureIndex();
    try {
      const result = await this.exec(['hierarchy', name, '--format', 'json']);
      try {
        return JSON.parse(result);
      } catch {
        return parseHierarchyText(result, name);
      }
    } catch (err) {
      console.error(`[token-pilot] ast-index hierarchy failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  async stats(): Promise<string | null> {
    try {
      return await this.exec(['stats']);
    } catch {
      return null;
    }
  }

  async listFiles(): Promise<string[]> {
    try {
      await this.ensureIndex();
      const result = await this.exec(['files'], 15000);
      return result.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    } catch (err) {
      console.error(`[token-pilot] ast-index files failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async refs(symbolName: string, limit = 20): Promise<AstIndexRefsResponse> {
    await this.ensureIndex();
    try {
      const result = await this.exec(['refs', symbolName, '--limit', String(limit), '--format', 'json']);
      return JSON.parse(result);
    } catch (err) {
      console.error(`[token-pilot] ast-index refs failed: ${err instanceof Error ? err.message : err}`);
      return { definitions: [], imports: [], usages: [] };
    }
  }

  async map(options?: { module?: string; limit?: number }): Promise<AstIndexMapResponse | null> {
    await this.ensureIndex();
    try {
      const args = ['map', '--format', 'json'];
      if (options?.module) args.push('--module', options.module);
      if (options?.limit) args.push('--limit', String(options.limit));
      const result = await this.exec(args, 15000);
      return JSON.parse(result);
    } catch (err) {
      console.error(`[token-pilot] ast-index map failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  async conventions(): Promise<AstIndexConventionsResponse | null> {
    await this.ensureIndex();
    try {
      const result = await this.exec(['conventions', '--format', 'json']);
      return JSON.parse(result);
    } catch (err) {
      console.error(`[token-pilot] ast-index conventions failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  async callers(functionName: string, limit = 50): Promise<AstIndexCallerEntry[]> {
    await this.ensureIndex();
    try {
      const result = await this.exec(['callers', functionName, '--limit', String(limit), '--format', 'json']);
      const parsed = JSON.parse(result);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error(`[token-pilot] ast-index callers failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async callTree(functionName: string, depth = 3): Promise<AstIndexCallTreeNode | null> {
    await this.ensureIndex();
    try {
      const result = await this.exec(['call-tree', functionName, '--depth', String(depth), '--format', 'json']);
      return JSON.parse(result);
    } catch (err) {
      console.error(`[token-pilot] ast-index call-tree failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  async changed(base?: string): Promise<AstIndexChangedEntry[]> {
    await this.ensureIndex();
    try {
      const args = ['changed', '--format', 'json'];
      if (base) args.push('--base', base);
      const result = await this.exec(args, 15000);
      const parsed = JSON.parse(result);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error(`[token-pilot] ast-index changed failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async unusedSymbols(options?: { module?: string; exportOnly?: boolean; limit?: number }): Promise<AstIndexUnusedSymbol[]> {
    await this.ensureIndex();
    try {
      const args = ['unused-symbols', '--format', 'json'];
      if (options?.module) args.push('--module', options.module);
      if (options?.exportOnly) args.push('--export-only');
      if (options?.limit) args.push('--limit', String(options.limit));
      const result = await this.exec(args, 15000);
      const parsed = JSON.parse(result);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error(`[token-pilot] ast-index unused-symbols failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async fileImports(filePath: string): Promise<AstIndexImportEntry[]> {
    await this.ensureIndex();
    try {
      const result = await this.exec(['imports', filePath]);
      return parseImportsText(result);
    } catch (err) {
      console.error(`[token-pilot] ast-index imports failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  // --- Code audit commands ---

  private async checkAstGrep(): Promise<boolean> {
    if (this.astGrepAvailable !== null) return this.astGrepAvailable;
    try {
      await execFileAsync('sg', ['--version'], { timeout: 3000 });
      this.astGrepAvailable = true;
      return true;
    } catch { /* not in PATH */ }
    try {
      const localBinDir = new URL('../../node_modules/.bin', import.meta.url).pathname;
      await execFileAsync(localBinDir + '/sg', ['--version'], { timeout: 3000 });
      this.astGrepBinDir = localBinDir;
      this.astGrepAvailable = true;
      return true;
    } catch { /* not found locally either */ }
    this.astGrepAvailable = false;
    return false;
  }

  async agrep(pattern: string, options?: { lang?: string; limit?: number }): Promise<AstIndexAgrepMatch[]> {
    if (this.indexDisabled || this.indexOversized) return [];
    await this.ensureIndex();

    const available = await this.checkAstGrep();
    if (!available) {
      throw new Error(
        'ast-grep (sg) not installed — required for structural pattern search.\n' +
        'Install: brew install ast-grep  OR  npm i -g @ast-grep/cli\n' +
        'Alternative: use Grep/ripgrep for text-based pattern search.',
      );
    }

    const limit = options?.limit ?? 50;
    const args = ['agrep', pattern];
    if (options?.lang) args.push('--lang', options.lang);

    try {
      const result = await this.exec(args, 15000);
      return parseAgrepText(result).slice(0, limit);
    } catch (err) {
      console.error(`[token-pilot] ast-index agrep failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async todo(): Promise<AstIndexTodoEntry[]> {
    if (this.indexDisabled || this.indexOversized) return [];
    await this.ensureIndex();
    try {
      const result = await this.exec(['todo'], 15000);
      return parseTodoText(result);
    } catch (err) {
      console.error(`[token-pilot] ast-index todo failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async deprecated(): Promise<AstIndexDeprecatedEntry[]> {
    if (this.indexDisabled || this.indexOversized) return [];
    await this.ensureIndex();
    try {
      const result = await this.exec(['deprecated'], 15000);
      return parseDeprecatedText(result);
    } catch (err) {
      console.error(`[token-pilot] ast-index deprecated failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async annotations(name: string): Promise<AstIndexAnnotationEntry[]> {
    if (this.indexDisabled || this.indexOversized) return [];
    await this.ensureIndex();
    try {
      const result = await this.exec(['annotations', name], 15000);
      return parseAnnotationsText(result, name);
    } catch (err) {
      console.error(`[token-pilot] ast-index annotations failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async incrementalUpdate(): Promise<void> {
    if (!this.indexed || this.indexDisabled || this.indexOversized) return;
    try {
      await this.exec(['update'], 15000);
    } catch (err) {
      console.error(`[token-pilot] ast-index incremental update failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // --- Module analysis methods ---

  async modules(pattern?: string): Promise<AstIndexModuleEntry[]> {
    if (this.indexDisabled || this.indexOversized) return [];
    await this.ensureIndex();
    try {
      const cmdArgs = pattern ? ['module', pattern] : ['module'];
      const result = await this.exec(cmdArgs, 15000);
      return parseModuleListText(result);
    } catch (err) {
      console.error(`[token-pilot] ast-index module failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async moduleDeps(module: string): Promise<AstIndexModuleDep[]> {
    if (this.indexDisabled || this.indexOversized) return [];
    await this.ensureIndex();
    try {
      const result = await this.exec(['deps', module], 15000);
      return parseModuleDepText(result);
    } catch (err) {
      console.error(`[token-pilot] ast-index deps failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async moduleDependents(module: string): Promise<AstIndexModuleDep[]> {
    if (this.indexDisabled || this.indexOversized) return [];
    await this.ensureIndex();
    try {
      const result = await this.exec(['dependents', module], 15000);
      return parseModuleDepText(result);
    } catch (err) {
      console.error(`[token-pilot] ast-index dependents failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async unusedDeps(module: string): Promise<AstIndexUnusedDep[]> {
    if (this.indexDisabled || this.indexOversized) return [];
    await this.ensureIndex();
    try {
      const result = await this.exec(['unused-deps', module], 15000);
      return parseUnusedDepsText(result);
    } catch (err) {
      console.error(`[token-pilot] ast-index unused-deps failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async moduleApi(module: string): Promise<AstIndexModuleApi[]> {
    if (this.indexDisabled || this.indexOversized) return [];
    await this.ensureIndex();
    try {
      const result = await this.exec(['api', module], 15000);
      return parseModuleApiText(result);
    } catch (err) {
      console.error(`[token-pilot] ast-index api failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  // --- Utility methods ---

  isAvailable(): boolean {
    return this.binaryPath !== null;
  }

  isOversized(): boolean {
    return this.indexOversized;
  }

  isDisabled(): boolean {
    return this.indexDisabled;
  }

  disableIndex(): void {
    this.indexDisabled = true;
  }

  enableIndex(): void {
    this.indexDisabled = false;
  }

  updateProjectRoot(newRoot: string): void {
    this.projectRoot = newRoot;
    this.indexed = false;
  }

  private async exec(args: string[], timeoutMs?: number): Promise<string> {
    if (!this.binaryPath) {
      throw new Error('ast-index not initialized. Call init() first.');
    }

    const env = this.astGrepBinDir
      ? { ...process.env, PATH: `${this.astGrepBinDir}:${process.env.PATH ?? ''}` }
      : undefined;

    const { stdout, stderr } = await execFileAsync(
      this.binaryPath,
      args,
      {
        timeout: timeoutMs ?? this.timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        cwd: this.projectRoot,
        ...(env && { env }),
      }
    );

    if (stderr) {
      console.error(`[token-pilot] ast-index stderr (${args[0]}): ${stderr.trim()}`);
    }

    return stdout;
  }
}
