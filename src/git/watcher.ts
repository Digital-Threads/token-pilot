import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { watch } from 'chokidar';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { FileCache } from '../core/file-cache.js';
import type { ContextRegistry } from '../core/context-registry.js';

const execFileAsync = promisify(execFile);

export class GitWatcher {
  private projectRoot: string;
  private fileCache: FileCache;
  private contextRegistry: ContextRegistry;
  private watcher: ReturnType<typeof watch> | null = null;
  private headRef: string = '';
  private enabled: boolean;
  private branchSwitchCallback: ((changedFiles: string[]) => void) | null = null;

  constructor(
    projectRoot: string,
    fileCache: FileCache,
    contextRegistry: ContextRegistry,
    enabled: boolean,
  ) {
    this.projectRoot = projectRoot;
    this.fileCache = fileCache;
    this.contextRegistry = contextRegistry;
    this.enabled = enabled;
  }

  async start(): Promise<void> {
    if (!this.enabled) return;

    // Read initial HEAD
    try {
      this.headRef = await this.readHead();
    } catch {
      // Not a git repo — disable watcher
      this.enabled = false;
      return;
    }

    // Watch .git/HEAD for branch switches
    const gitHeadPath = resolve(this.projectRoot, '.git', 'HEAD');
    this.watcher = watch(gitHeadPath, { persistent: false });

    this.watcher.on('change', async () => {
      try {
        const newHead = await this.readHead();
        if (newHead !== this.headRef) {
          this.headRef = newHead;
          await this.onBranchSwitch();
        }
      } catch {
        // ignore read errors
      }
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /**
   * Get files changed between current working tree and HEAD.
   * Used for selective cache invalidation after edits.
   */
  async getChangedFiles(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        'git', ['diff', '--name-only', 'HEAD'],
        { cwd: this.projectRoot, timeout: 5000 }
      );
      return stdout.trim().split('\n')
        .filter(f => f.length > 0)
        .map(f => resolve(this.projectRoot, f));
    } catch {
      return [];
    }
  }

  /**
   * Get files changed in the last N commits.
   */
  async getRecentlyChangedFiles(commits = 1): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        'git', ['diff', '--name-only', `HEAD~${commits}`, 'HEAD'],
        { cwd: this.projectRoot, timeout: 5000 }
      );
      return stdout.trim().split('\n')
        .filter(f => f.length > 0)
        .map(f => resolve(this.projectRoot, f));
    } catch {
      return [];
    }
  }

  /** Register callback for branch switch events. */
  onBranchSwitchEvent(callback: (changedFiles: string[]) => void): void {
    this.branchSwitchCallback = callback;
  }

  private async onBranchSwitch(): Promise<void> {
    // On branch switch, get files that differ between old and new branch
    // and selectively invalidate only those
    const changed = await this.getChangedFiles();
    if (changed.length > 0) {
      await this.fileCache.invalidateByGitDiff(changed);
      this.contextRegistry.invalidateByGitDiff(changed);
      this.branchSwitchCallback?.(changed);
    }
  }

  private async readHead(): Promise<string> {
    const headContent = await readFile(
      resolve(this.projectRoot, '.git', 'HEAD'), 'utf-8'
    );
    return headContent.trim();
  }
}
