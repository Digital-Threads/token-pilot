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
} from './types.js';
import { findBinary, installBinary } from './binary-manager.js';

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

    // Project root is too broad (/, home dir) — refuse to build
    if (this.indexDisabled) {
      throw new Error(
        'ast-index: index build disabled — project root is too broad (e.g. /). ' +
        'Configure mcpServers with "args": ["/path/to/project"] to set the correct project root.'
      );
    }

    // If a previous build found >50k files, don't retry
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
    // Check if index already exists and has files
    let existingFileCount = 0;
    try {
      const stats = await this.exec(['--format', 'json', 'stats']);
      existingFileCount = this.parseFileCount(stats);
    } catch { /* no index yet */ }

    // Guard: existing index is oversized (node_modules leak from previous build)
    if (existingFileCount > AstIndexClient.MAX_INDEX_FILES) {
      console.error(`[token-pilot] ast-index: existing index has ${existingFileCount} files (>${AstIndexClient.MAX_INDEX_FILES}) — likely includes node_modules. Clearing.`);
      try { await this.exec(['clear']); } catch { /* best effort */ }
      existingFileCount = 0;
      // Fall through to rebuild — maybe .gitignore was fixed
    }

    if (existingFileCount > 0) {
      // Index exists — use incremental update (fast)
      console.error(`[token-pilot] ast-index: updating index (${existingFileCount} files)...`);
      try {
        await this.exec(['update'], 30000);
        // Re-check count after update
        try {
          existingFileCount = this.parseFileCount(await this.exec(['--format', 'json', 'stats']));
        } catch { /* keep previous count */ }

        // Guard: update may have grown index beyond limit
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

    // No index or update failed — full rebuild
    console.error('[token-pilot] ast-index: building index (this may take a moment)...');
    try {
      await this.exec(['rebuild'], 120000);

      const fileCount = this.parseFileCount(await this.exec(['--format', 'json', 'stats']).catch(() => ''));

      // Guard: rebuild produced oversized index
      if (fileCount > AstIndexClient.MAX_INDEX_FILES) {
        return this.handleOversizedIndex(fileCount);
      }

      this.indexed = true;
      console.error(`[token-pilot] ast-index: index built (${fileCount} files)`);
    } catch (buildErr) {
      // If rebuild failed due to lock, check if index is usable anyway
      const errMsg = buildErr instanceof Error ? buildErr.message : String(buildErr);
      if (errMsg.includes('lock') || errMsg.includes('already running')) {
        const count = this.parseFileCount(await this.exec(['--format', 'json', 'stats']).catch(() => ''));
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

  /** Mark index as oversized — disables index-dependent tools, outline still works */
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

  /** Extract file count from stats output (JSON or text) */
  private parseFileCount(statsText: string): number {
    // Try JSON first (--format json)
    try {
      const json = JSON.parse(statsText);
      if (json?.stats?.file_count !== undefined) return json.stats.file_count;
    } catch { /* not JSON, fall through */ }
    // Fallback: text format
    const match = statsText.match(/Files:\s*(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  async outline(filePath: string): Promise<FileStructure | null> {
    // outline parses a single file — try directly without requiring full index
    try {
      const result = await this.exec(['outline', filePath]);
      const entries = this.parseOutlineText(result);
      if (entries.length === 0) return null;
      return await this.buildFileStructure(filePath, entries);
    } catch {
      // Direct call failed — try building index first (unless disabled/oversized)
      if (this.indexDisabled || this.indexOversized) return null;
      try {
        await this.ensureIndex();
        const result = await this.exec(['outline', filePath]);
        const entries = this.parseOutlineText(result);
        if (entries.length === 0) return null;
        return await this.buildFileStructure(filePath, entries);
      } catch (err) {
        console.error(`[token-pilot] ast-index outline failed for ${filePath}: ${err instanceof Error ? err.message : err}`);
        return null;
      }
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
    // Try directly first (works if index exists from a previous session)
    try {
      const result = await this.exec(['symbol', name, '--format', 'json']);
      const raw: AstIndexSymbolRaw[] = JSON.parse(result);
      if (Array.isArray(raw) && raw.length > 0) {
        const first = raw[0];
        return { name: first.name, kind: first.kind, file: first.path, start_line: first.line, signature: first.signature };
      }
    } catch { /* fall through to ensureIndex path */ }

    // Direct call failed — try building index (unless disabled/oversized)
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
      // Fallback: if parsed is an array directly
      const matches = all.length > 0 ? all : (Array.isArray(parsed) ? parsed : []);
      const mapped = matches
        .map((m: { content?: string; text?: string; signature?: string; line?: number; path?: string; file?: string }) => ({
          file: m.path ?? m.file ?? '',
          line: typeof m.line === 'number' ? m.line : 0,
          text: m.content ?? m.text ?? m.signature ?? '',
        }))
        .filter(r => r.file !== '' && r.text !== '');

      // Deduplicate by file:line (merge of 4 categories creates dupes)
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
      return raw.map(u => ({
        file: u.path,
        line: u.line,
        text: u.context,
        kind: 'reference',
      }));
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
        // JSON parse failed — parse text format as fallback
        return this.parseImplementationsText(result);
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
        // JSON parse failed — parse text format as fallback
        return this.parseHierarchyText(result, name);
      }
    } catch (err) {
      console.error(`[token-pilot] ast-index hierarchy failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private parseImplementationsText(text: string): AstIndexImplementation[] {
    const results: AstIndexImplementation[] = [];
    // Parse lines like: "class ClassName (file.php:42)"
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(class|interface|trait|struct|impl)\s+(\S+)\s+\((.+):(\d+)\)/);
      if (m) {
        results.push({ kind: m[1], name: m[2], file: m[3], line: parseInt(m[4], 10) });
      }
    }
    return results;
  }

  private parseHierarchyText(text: string, rootName: string): AstIndexHierarchyNode | null {
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
          kind: m[2], // extends, implements, etc.
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

  async stats(): Promise<string | null> {
    try {
      return await this.exec(['stats']);
    } catch {
      return null;
    }
  }

  /**
   * List all files known to the ast-index.
   * Parses the `files` command output which lists one file per line.
   */
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

  /**
   * Cross-references: definitions + imports + usages in one call.
   * Replaces separate symbol() + usages() calls.
   */
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

  /**
   * Project map: directory structure with file counts and symbol kinds.
   */
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

  /**
   * Detect project conventions: architecture, frameworks, naming patterns.
   */
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

  /**
   * Find callers of a function.
   */
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

  /**
   * Show call hierarchy tree (callers tree up).
   */
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

  /**
   * Show changed symbols since base branch (git diff).
   */
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

  /**
   * Find potentially unused symbols.
   */
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

  /**
   * Get imports for a specific file.
   * Parses text output: "  { X, Y } from 'source';"
   */
  async fileImports(filePath: string): Promise<AstIndexImportEntry[]> {
    await this.ensureIndex();
    try {
      const result = await this.exec(['imports', filePath]);
      return this.parseImportsText(result);
    } catch (err) {
      console.error(`[token-pilot] ast-index imports failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private parseImportsText(text: string): AstIndexImportEntry[] {
    const entries: AstIndexImportEntry[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Imports in') || trimmed.startsWith('Total:')) continue;

      // Match: { X, Y } from 'source'
      const braceMatch = trimmed.match(/^\{\s*(.+?)\s*\}\s+from\s+['"](.+?)['"]/);
      if (braceMatch) {
        entries.push({
          specifiers: braceMatch[1].split(',').map(s => s.trim()),
          source: braceMatch[2],
        });
        continue;
      }

      // Match: * as X from 'source'
      const nsMatch = trimmed.match(/^\*\s+as\s+(\S+)\s+from\s+['"](.+?)['"]/);
      if (nsMatch) {
        entries.push({
          specifiers: [nsMatch[1]],
          source: nsMatch[2],
          isNamespace: true,
        });
        continue;
      }

      // Match: X from 'source' (default import)
      const defaultMatch = trimmed.match(/^(\w+)\s+from\s+['"](.+?)['"]/);
      if (defaultMatch) {
        entries.push({
          specifiers: [defaultMatch[1]],
          source: defaultMatch[2],
          isDefault: true,
        });
        continue;
      }
    }
    return entries;
  }

  // --- Code audit commands ---

  /** Check if ast-grep (sg) is available for structural pattern search */
  private async checkAstGrep(): Promise<boolean> {
    if (this.astGrepAvailable !== null) return this.astGrepAvailable;
    // Try system PATH first
    try {
      await execFileAsync('sg', ['--version'], { timeout: 3000 });
      this.astGrepAvailable = true;
      return true;
    } catch { /* not in PATH */ }
    // Try node_modules/.bin/sg (from optionalDependencies or source installs)
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

  /** Structural pattern search via ast-grep. Requires ast-grep (sg) installed. */
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
      return this.parseAgrepText(result).slice(0, limit);
    } catch (err) {
      console.error(`[token-pilot] ast-index agrep failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private parseAgrepText(text: string): AstIndexAgrepMatch[] {
    const results: AstIndexAgrepMatch[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // Format: file:line:matched_text  OR  file:line: matched_text
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (match) {
        results.push({
          file: match[1],
          line: parseInt(match[2], 10),
          text: match[3].trim(),
        });
      }
    }
    return results;
  }

  /** Find TODO/FIXME/HACK comments in the project */
  async todo(): Promise<AstIndexTodoEntry[]> {
    if (this.indexDisabled || this.indexOversized) return [];
    await this.ensureIndex();

    try {
      const result = await this.exec(['todo'], 15000);
      return this.parseTodoText(result);
    } catch (err) {
      console.error(`[token-pilot] ast-index todo failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private parseTodoText(text: string): AstIndexTodoEntry[] {
    const results: AstIndexTodoEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // Try format: file:line: KIND: message  OR  file:line: KIND message
      const match = line.match(/^(.+?):(\d+):\s*(TODO|FIXME|HACK|XXX|NOTE|WARN(?:ING)?)[:\s]+(.*)$/i);
      if (match) {
        results.push({
          file: match[1],
          line: parseInt(match[2], 10),
          kind: match[3].toUpperCase(),
          text: match[4].trim(),
        });
      }
    }
    return results;
  }

  /** Find @Deprecated symbols in the project */
  async deprecated(): Promise<AstIndexDeprecatedEntry[]> {
    if (this.indexDisabled || this.indexOversized) return [];
    await this.ensureIndex();

    try {
      const result = await this.exec(['deprecated'], 15000);
      return this.parseDeprecatedText(result);
    } catch (err) {
      console.error(`[token-pilot] ast-index deprecated failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private parseDeprecatedText(text: string): AstIndexDeprecatedEntry[] {
    const results: AstIndexDeprecatedEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // Try format: kind name (file:line) - message  OR  kind name (file:line)
      const match = line.match(/^(\w+)\s+(\S+)\s+\((.+?):(\d+)\)(?:\s*-\s*(.+))?$/);
      if (match) {
        results.push({
          kind: match[1],
          name: match[2],
          file: match[3],
          line: parseInt(match[4], 10),
          message: match[5]?.trim(),
        });
      }
    }
    return results;
  }

  /** Find symbols with a specific annotation/decorator */
  async annotations(name: string): Promise<AstIndexAnnotationEntry[]> {
    if (this.indexDisabled || this.indexOversized) return [];
    await this.ensureIndex();

    try {
      const result = await this.exec(['annotations', name], 15000);
      return this.parseAnnotationsText(result, name);
    } catch (err) {
      console.error(`[token-pilot] ast-index annotations failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private parseAnnotationsText(text: string, annotationName: string): AstIndexAnnotationEntry[] {
    const results: AstIndexAnnotationEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // Try format: kind name (file:line)  OR  @Annotation kind name (file:line)
      const match = line.match(/^(?:@\S+\s+)?(\w+)\s+(\S+)\s+\((.+?):(\d+)\)$/);
      if (match) {
        results.push({
          kind: match[1],
          name: match[2],
          file: match[3],
          line: parseInt(match[4], 10),
          annotation: annotationName,
        });
      }
    }
    return results;
  }

  /** Trigger incremental index update (called by file watcher after edits) */
  async incrementalUpdate(): Promise<void> {
    if (!this.indexed || this.indexDisabled || this.indexOversized) return;
    try {
      await this.exec(['update'], 15000);
    } catch (err) {
      console.error(`[token-pilot] ast-index incremental update failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // --- Utility methods ---

  isAvailable(): boolean {
    return this.binaryPath !== null;
  }

  /** Returns true if the index was built but found >50k files (node_modules leak) */
  isOversized(): boolean {
    return this.indexOversized;
  }

  /** Returns true if index building is disabled (dangerous root like /) */
  isDisabled(): boolean {
    return this.indexDisabled;
  }

  /** Disable index building (e.g. project root is / or home dir) */
  disableIndex(): void {
    this.indexDisabled = true;
  }

  /** Re-enable index building after auto-detecting a valid project root */
  enableIndex(): void {
    this.indexDisabled = false;
  }

  /** Update project root (e.g. after auto-detecting from file path) */
  updateProjectRoot(newRoot: string): void {
    this.projectRoot = newRoot;
    this.indexed = false; // Force re-check
  }

  private async exec(args: string[], timeoutMs?: number): Promise<string> {
    if (!this.binaryPath) {
      throw new Error('ast-index not initialized. Call init() first.');
    }

    // If ast-grep was found in node_modules/.bin, inject it into PATH
    // so ast-index can find sg when running agrep
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

  private async buildFileStructure(
    filePath: string,
    entries: AstIndexOutlineEntry[]
  ): Promise<FileStructure> {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const fileStat = await stat(filePath);

    // Fix last entry end_line to use actual file line count
    this.fixLastEndLine(entries, lines.length);

    // Enrich classes that ast-index returned without children (language-specific)
    const lang = this.detectLanguage(filePath);
    if (lang === 'Python') {
      this.enrichPythonClassMethods(entries, lines);
    } else if (lang === 'PHP') {
      this.enrichPHPClassMethods(entries, lines);
    }

    // Enrich entries with signatures from file content
    this.enrichSignatures(entries, lines);

    return {
      path: filePath,
      language: lang,
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

  /**
   * Python: ast-index doesn't return methods inside classes.
   * Parse file content to extract `def` methods for classes without children.
   */
  private enrichPythonClassMethods(entries: AstIndexOutlineEntry[], lines: string[]): void {
    for (const entry of entries) {
      if (entry.kind.toLowerCase() !== 'class') continue;
      if (entry.children && entry.children.length > 0) continue;

      const classStartIdx = entry.start_line - 1; // 0-based
      const classEndIdx = entry.end_line - 1;

      // Detect class body indent: look for first `def ` inside class range
      let bodyIndent = -1;
      for (let i = classStartIdx + 1; i <= classEndIdx && i < lines.length; i++) {
        const defMatch = lines[i].match(/^(\s+)def\s/);
        if (defMatch) {
          bodyIndent = defMatch[1].length;
          break;
        }
      }
      if (bodyIndent < 0) continue; // no methods found

      const methods: AstIndexOutlineEntry[] = [];

      for (let i = classStartIdx + 1; i <= classEndIdx && i < lines.length; i++) {
        const line = lines[i];
        // Match `def method_name(` at the detected indent level
        const match = line.match(new RegExp(`^\\s{${bodyIndent}}def\\s+(\\w+)\\s*\\(`));
        if (!match) continue;

        const methodName = match[1];
        const methodLine = i + 1; // 1-based

        // Check for async/static/decorators
        const isAsync = line.includes('async def');
        const isStatic = i > 0 && /^\s*@staticmethod/.test(lines[i - 1]);
        const isClassMethod = i > 0 && /^\s*@classmethod/.test(lines[i - 1]);

        // Collect decorators above
        const decorators: string[] = [];
        for (let d = i - 1; d >= classStartIdx; d--) {
          const decMatch = lines[d].match(new RegExp(`^\\s{${bodyIndent}}@(\\w+)`));
          if (decMatch) {
            decorators.unshift(`@${decMatch[1]}`);
          } else {
            break;
          }
        }

        // Determine visibility from name
        const visibility = methodName.startsWith('__') && !methodName.endsWith('__')
          ? 'private'
          : methodName.startsWith('_')
            ? 'protected'
            : 'public';

        methods.push({
          name: methodName,
          kind: isStatic || isClassMethod ? 'function' : 'method',
          start_line: methodLine,
          end_line: 0, // computed below
          signature: line.trim(),
          visibility,
          is_async: isAsync,
          is_static: isStatic,
          decorators: decorators.length > 0 ? decorators : undefined,
        });
      }

      // Compute end_lines for methods
      for (let m = 0; m < methods.length; m++) {
        if (m < methods.length - 1) {
          // End before next method (or its first decorator)
          const nextStart = methods[m + 1].start_line;
          // Walk back from next method to skip decorators/blank lines
          let endLine = nextStart - 1;
          for (let k = nextStart - 2; k >= methods[m].start_line; k--) {
            const l = lines[k];
            if (l.trim() === '' || new RegExp(`^\\s{${bodyIndent}}@`).test(l)) {
              endLine = k; // 0-based → will be used as 1-based below
            } else {
              break;
            }
          }
          methods[m].end_line = endLine;
        } else {
          // Last method ends at class end
          methods[m].end_line = entry.end_line;
        }
      }

      entry.children = methods;
    }
  }

  /**
   * PHP: ast-index doesn't return methods inside classes.
   * Parse file content to extract `function` methods for classes without children.
   */
  private enrichPHPClassMethods(entries: AstIndexOutlineEntry[], lines: string[]): void {
    for (const entry of entries) {
      if (entry.kind.toLowerCase() !== 'class') continue;
      if (entry.children && entry.children.length > 0) continue;

      const classStartIdx = entry.start_line - 1;
      const classEndIdx = entry.end_line - 1;

      // Detect class body indent: look for first `function ` inside class range
      let bodyIndent = -1;
      for (let i = classStartIdx + 1; i <= classEndIdx && i < lines.length; i++) {
        const fnMatch = lines[i].match(/^(\s+)(?:public|private|protected|static|\s)*function\s/);
        if (fnMatch) {
          bodyIndent = fnMatch[1].length;
          break;
        }
      }
      if (bodyIndent < 0) continue;

      const methods: AstIndexOutlineEntry[] = [];

      for (let i = classStartIdx + 1; i <= classEndIdx && i < lines.length; i++) {
        const line = lines[i];
        // Match PHP method: [visibility] [static] function name(
        const match = line.match(
          new RegExp(`^\\s{${bodyIndent}}(?:(public|private|protected)\\s+)?(?:(static)\\s+)?function\\s+(\\w+)\\s*\\(`)
        );
        if (!match) continue;

        const visibility = match[1] ?? 'public';
        const isStatic = !!match[2];
        const methodName = match[3];
        const methodLine = i + 1;

        methods.push({
          name: methodName,
          kind: isStatic ? 'function' : 'method',
          start_line: methodLine,
          end_line: 0,
          signature: line.trim(),
          visibility,
          is_static: isStatic,
        });
      }

      // Compute end_lines
      for (let m = 0; m < methods.length; m++) {
        if (m < methods.length - 1) {
          methods[m].end_line = methods[m + 1].start_line - 1;
        } else {
          methods[m].end_line = entry.end_line;
        }
      }

      entry.children = methods;
    }
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
