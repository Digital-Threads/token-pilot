import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, access, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { homedir, platform, arch } from 'node:os';
import { get as httpsGet } from 'node:https';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { tarExtract } from './tar-extract.js';

const REPO = 'defendend/Claude-ast-index-search';
const BINARY_NAME = platform() === 'win32' ? 'ast-index.exe' : 'ast-index';
const INSTALL_DIR = resolve(homedir(), '.token-pilot', 'bin');

export interface BinaryStatus {
  available: boolean;
  path: string;
  version: string | null;
  source: 'system' | 'managed' | 'none';
}

/**
 * Find ast-index binary: check system PATH first, then managed install.
 */
export async function findBinary(configPath?: string | null): Promise<BinaryStatus> {
  // 1. Config override
  if (configPath) {
    const version = await getBinaryVersion(configPath);
    if (version) {
      return { available: true, path: configPath, version, source: 'system' };
    }
  }

  // 2. System PATH
  const systemPath = await findInPath();
  if (systemPath) {
    const version = await getBinaryVersion(systemPath);
    return { available: true, path: systemPath, version, source: 'system' };
  }

  // 3. Managed install
  const managedPath = resolve(INSTALL_DIR, BINARY_NAME);
  const version = await getBinaryVersion(managedPath);
  if (version) {
    return { available: true, path: managedPath, version, source: 'managed' };
  }

  return { available: false, path: '', version: null, source: 'none' };
}

/**
 * Download and install ast-index binary from GitHub releases.
 */
export async function installBinary(
  onProgress?: (msg: string) => void,
): Promise<BinaryStatus> {
  const log = onProgress ?? (() => {});

  // Determine platform/arch
  const plat = getPlatform();
  const ar = getArch();
  if (!plat || !ar) {
    throw new Error(`Unsupported platform: ${platform()} ${arch()}`);
  }

  log('Fetching latest release info...');
  const release = await fetchLatestRelease();

  const assetName = buildAssetName(release.tag, plat, ar);
  const asset = release.assets.find(a => a.name === assetName);
  if (!asset) {
    throw new Error(
      `No binary found for ${plat}-${ar}. Available: ${release.assets.map(a => a.name).join(', ')}`,
    );
  }

  log(`Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)}MB)...`);

  await mkdir(INSTALL_DIR, { recursive: true });
  const tmpPath = resolve(INSTALL_DIR, `${BINARY_NAME}.tmp`);
  const finalPath = resolve(INSTALL_DIR, BINARY_NAME);

  try {
    if (assetName.endsWith('.tar.gz')) {
      await downloadAndExtractTarGz(asset.url, INSTALL_DIR, BINARY_NAME);
    } else if (assetName.endsWith('.zip')) {
      // For Windows, download zip and extract
      await downloadFile(asset.url, tmpPath);
      // Simple approach: use system unzip if available
      throw new Error('ZIP extraction not yet supported. Please install ast-index manually on Windows.');
    }

    await chmod(finalPath, 0o755);

    const version = await getBinaryVersion(finalPath);
    log(`Installed ast-index ${version} to ${finalPath}`);

    return { available: true, path: finalPath, version, source: 'managed' };
  } catch (err) {
    // Cleanup on failure
    try { await rm(tmpPath, { force: true }); } catch {}
    try { await rm(finalPath, { force: true }); } catch {}
    throw err;
  }
}

/**
 * Check if a newer version of ast-index is available on GitHub.
 * Non-blocking, returns null values on any error.
 */
export async function checkBinaryUpdate(
  currentPath: string | null,
): Promise<{ current: string | null; latest: string | null; updateAvailable: boolean }> {
  if (!currentPath) {
    return { current: null, latest: null, updateAvailable: false };
  }

  try {
    const [current, release] = await Promise.all([
      getBinaryVersion(currentPath),
      fetchLatestRelease(),
    ]);

    const latest = release.tag.replace(/^v/, '');

    if (!current) {
      return { current: null, latest, updateAvailable: false };
    }

    return {
      current,
      latest,
      updateAvailable: isNewerVersion(current, latest),
    };
  } catch {
    return { current: null, latest: null, updateAvailable: false };
  }
}

/**
 * Compare two semver strings. Returns true if `latest` is newer than `current`.
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const c = current.replace(/^v/, '').split('.').map(Number);
  const l = latest.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const cv = c[i] ?? 0;
    const lv = l[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

// --- Internal helpers ---

function getPlatform(): string | null {
  switch (platform()) {
    case 'darwin': return 'darwin';
    case 'linux': return 'linux';
    case 'win32': return 'windows';
    default: return null;
  }
}

function getArch(): string | null {
  switch (arch()) {
    case 'arm64': return 'arm64';
    case 'x64': return 'x86_64';
    default: return null;
  }
}

function buildAssetName(tag: string, plat: string, ar: string): string {
  const ext = plat === 'windows' ? '.zip' : '.tar.gz';
  return `ast-index-${tag}-${plat}-${ar}${ext}`;
}

async function findInPath(): Promise<string | null> {
  return new Promise(resolve => {
    const cmd = platform() === 'win32' ? 'where' : 'which';
    execFile(cmd, ['ast-index'], (err, stdout) => {
      if (err) return resolve(null);
      const path = stdout.trim().split('\n')[0];
      resolve(path || null);
    });
  });
}

async function getBinaryVersion(binaryPath: string): Promise<string | null> {
  try {
    await access(binaryPath);
  } catch {
    return null;
  }

  return new Promise(resolve => {
    execFile(binaryPath, ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      // Parse "ast-index v3.24.0" or "ast-index 3.24.0"
      const match = stdout.trim().match(/v?(\d+\.\d+\.\d+)/);
      resolve(match ? match[1] : null);
    });
  });
}

interface ReleaseInfo {
  tag: string;
  assets: Array<{ name: string; url: string; size: number }>;
}

async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const data = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);

  return {
    tag: data.tag_name,
    assets: (data.assets ?? []).map((a: any) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
    })),
  };
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'token-pilot' },
    };

    httpsGet(url, options, (res) => {
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (!location) return reject(new Error('Redirect without location'));
        fetchJson(location).then(resolve).catch(reject);
        res.resume();
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }

      let body = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Invalid JSON from ${url}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function followRedirects(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith('https') ? httpsGet : httpGet;
    getter(url, { headers: { 'User-Agent': 'token-pilot' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (!location) return reject(new Error('Redirect without location'));
        res.resume();
        followRedirects(location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} downloading from ${url}`));
      }
      resolve(res);
    }).on('error', reject);
  });
}

async function downloadAndExtractTarGz(url: string, destDir: string, binaryName: string): Promise<void> {
  const res = await followRedirects(url);
  const gunzip = createGunzip();

  // Pipe through gunzip, then our custom tar extractor
  const chunks: Buffer[] = [];
  res.pipe(gunzip);

  await new Promise<void>((resolve, reject) => {
    gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gunzip.on('end', resolve);
    gunzip.on('error', reject);
    res.on('error', reject);
  });

  const tarData = Buffer.concat(chunks);
  await tarExtract(tarData, destDir, binaryName);
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await followRedirects(url);
  const fileStream = createWriteStream(destPath);
  await pipeline(res, fileStream);
}
