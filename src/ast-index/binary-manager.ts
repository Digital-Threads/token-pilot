import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, access, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { homedir, platform, arch } from "node:os";
import { get as httpsGet } from "node:https";
import { get as httpGet, type IncomingMessage } from "node:http";
import { tarExtract } from "./tar-extract.js";

const REPO = "defendend/Claude-ast-index-search";
const BINARY_NAME = platform() === "win32" ? "ast-index.exe" : "ast-index";
const INSTALL_DIR = resolve(homedir(), ".token-pilot", "bin");

export interface BinaryStatus {
  available: boolean;
  path: string;
  version: string | null;
  source: "system" | "npm" | "managed" | "bundled" | "none";
}

/**
 * Find ast-index binary: config → system PATH → npm global → managed install.
 */
export async function findBinary(
  configPath?: string | null,
): Promise<BinaryStatus> {
  // 1. Config override
  if (configPath) {
    const version = await getBinaryVersion(configPath);
    if (version) {
      return { available: true, path: configPath, version, source: "system" };
    }
  }

  // 2. Bundled npm dep — @ast-index/cli alongside our own install. This is
  //    the default path when the user ran `npm install token-pilot`: npm
  //    resolves per-platform binary (@ast-index/cli-linux-x64 etc.) as an
  //    optional dep of @ast-index/cli, symlinks ast-index into
  //    node_modules/.bin alongside our own bin/, and everything "just works".
  const bundledPath = await findViaBundledDep();
  if (bundledPath) {
    const version = await getBinaryVersion(bundledPath);
    if (version) {
      return { available: true, path: bundledPath, version, source: "bundled" };
    }
  }

  // 3. System PATH
  const systemPath = await findInPath();
  if (systemPath) {
    const version = await getBinaryVersion(systemPath);
    return { available: true, path: systemPath, version, source: "system" };
  }

  // 3. npm global install (@ast-index/cli)
  const npmPath = await findViaNpmBin();
  if (npmPath) {
    const version = await getBinaryVersion(npmPath);
    if (version) {
      return { available: true, path: npmPath, version, source: "npm" };
    }
  }

  // 4. Managed install (GitHub download)
  const managedPath = resolve(INSTALL_DIR, BINARY_NAME);
  const version = await getBinaryVersion(managedPath);
  if (version) {
    return { available: true, path: managedPath, version, source: "managed" };
  }

  return { available: false, path: "", version: null, source: "none" };
}

/**
 * Install ast-index: tries npm global first (all platforms), falls back to GitHub download.
 */
export async function installBinary(
  onProgress?: (msg: string) => void,
): Promise<BinaryStatus> {
  const log = onProgress ?? (() => {});

  // Try npm first — simpler, handles all platforms including Windows
  try {
    return await installViaNpm(log);
  } catch (npmErr) {
    log(
      `npm install failed (${npmErr instanceof Error ? npmErr.message : npmErr}), trying GitHub download...`,
    );
  }

  // GitHub download fallback
  return installViaNpmFallback(log);
}

async function installViaNpm(
  onProgress: (msg: string) => void,
): Promise<BinaryStatus> {
  onProgress("Installing @ast-index/cli via npm...");

  await new Promise<void>((resolve, reject) => {
    execFile(
      "npm",
      ["install", "-g", "@ast-index/cli"],
      { timeout: 120_000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve();
      },
    );
  });

  const binPath = await findViaNpmBin();
  if (!binPath) {
    throw new Error(
      "@ast-index/cli installed but binary not found in npm prefix",
    );
  }

  const version = await getBinaryVersion(binPath);
  onProgress(`Installed ast-index ${version} via npm at ${binPath}`);
  return { available: true, path: binPath, version, source: "npm" };
}

async function installViaNpmFallback(
  onProgress: (msg: string) => void,
): Promise<BinaryStatus> {
  // Determine platform/arch
  const plat = getPlatform();
  const ar = getArch();
  if (!plat || !ar) {
    throw new Error(`Unsupported platform: ${platform()} ${arch()}`);
  }

  onProgress("Fetching latest release info...");
  const release = await fetchLatestRelease();

  const assetName = buildAssetName(release.tag, plat, ar);
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(
      `No binary found for ${plat}-${ar}. Available: ${release.assets.map((a) => a.name).join(", ")}`,
    );
  }

  onProgress(
    `Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)}MB)...`,
  );

  await mkdir(INSTALL_DIR, { recursive: true });
  const tmpPath = resolve(INSTALL_DIR, `${BINARY_NAME}.tmp`);
  const finalPath = resolve(INSTALL_DIR, BINARY_NAME);

  try {
    if (assetName.endsWith(".tar.gz")) {
      await downloadAndExtractTarGz(asset.url, INSTALL_DIR, BINARY_NAME);
    } else {
      await downloadFile(asset.url, tmpPath);
      throw new Error(
        "ZIP extraction not yet supported. Please use: npm install -g @ast-index/cli",
      );
    }

    await chmod(finalPath, 0o755);

    const version = await getBinaryVersion(finalPath);
    onProgress(`Installed ast-index ${version} to ${finalPath}`);

    return { available: true, path: finalPath, version, source: "managed" };
  } catch (err) {
    try {
      await rm(tmpPath, { force: true });
    } catch {}
    try {
      await rm(finalPath, { force: true });
    } catch {}
    throw err;
  }
}

/**
 * Check if a newer version of ast-index is available on GitHub.
 * Non-blocking, returns null values on any error.
 */
export async function checkBinaryUpdate(currentPath: string | null): Promise<{
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
}> {
  if (!currentPath) {
    return { current: null, latest: null, updateAvailable: false };
  }

  try {
    const [current, release] = await Promise.all([
      getBinaryVersion(currentPath),
      fetchLatestRelease(),
    ]);

    const latest = release.tag.replace(/^v/, "");

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
  const c = current.replace(/^v/, "").split(".").map(Number);
  const l = latest.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const cv = c[i] ?? 0;
    const lv = l[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

// --- Internal helpers ---

/**
 * Find ast-index bundled as a direct dependency of token-pilot. Walks up
 * from this module (dist/ast-index/binary-manager.js → node_modules/…/
 * @ast-index/cli/bin/ast-index) looking for the standard npm layout.
 *
 * Three locations are tried, in order of how npm installs usually resolve:
 *   - peer dir    : node_modules/.bin/ast-index  (our own node_modules)
 *   - parent dir  : ../../.bin/ast-index        (hoisted install)
 *   - bin script  : ../@ast-index/cli/bin/ast-index (platform-specific
 *     sub-package delegates to this JS shim)
 *
 * Returns null on any filesystem error — auto-install downstream still
 * works; we only lose the "prefer local" optimisation.
 */
async function findViaBundledDep(): Promise<string | null> {
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }

  const candidates = [
    // .../node_modules/token-pilot/dist/ast-index → up to .../node_modules/.bin
    resolve(here, "..", "..", "..", ".bin", BINARY_NAME),
    // Hoisted npm layout (same but one level deeper)
    resolve(here, "..", "..", "..", "..", ".bin", BINARY_NAME),
    // Direct module bin script (platform-agnostic JS shim in @ast-index/cli)
    resolve(here, "..", "..", "..", "@ast-index", "cli", "bin", BINARY_NAME),
    resolve(
      here,
      "..",
      "..",
      "..",
      "..",
      "@ast-index",
      "cli",
      "bin",
      BINARY_NAME,
    ),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Find ast-index binary installed via `npm install -g @ast-index/cli`.
 * Checks the npm global prefix bin directory.
 */
async function findViaNpmBin(): Promise<string | null> {
  try {
    const prefix = await new Promise<string>((resolve, reject) => {
      execFile(
        "npm",
        ["config", "get", "prefix"],
        { timeout: 3000 },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        },
      );
    });

    // Unix: <prefix>/bin/ast-index  |  Windows: <prefix>\ast-index.exe or <prefix>\bin\ast-index.exe
    const candidates =
      platform() === "win32"
        ? [resolve(prefix, BINARY_NAME), resolve(prefix, "bin", BINARY_NAME)]
        : [resolve(prefix, "bin", BINARY_NAME)];

    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {}
    }
  } catch {}
  return null;
}

function getPlatform(): string | null {
  switch (platform()) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return null;
  }
}

function getArch(): string | null {
  switch (arch()) {
    case "arm64":
      return "arm64";
    case "x64":
      return "x86_64";
    default:
      return null;
  }
}

function buildAssetName(tag: string, plat: string, ar: string): string {
  const ext = plat === "windows" ? ".zip" : ".tar.gz";
  return `ast-index-${tag}-${plat}-${ar}${ext}`;
}

async function findInPath(): Promise<string | null> {
  return new Promise((resolve) => {
    const cmd = platform() === "win32" ? "where" : "which";
    execFile(cmd, ["ast-index"], (err, stdout) => {
      if (err) return resolve(null);
      const path = stdout.trim().split("\n")[0];
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

  return new Promise((resolve) => {
    execFile(binaryPath, ["--version"], { timeout: 5000 }, (err, stdout) => {
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
  const data = await fetchJson(
    `https://api.github.com/repos/${REPO}/releases/latest`,
  );

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
      headers: { "User-Agent": "token-pilot" },
    };

    httpsGet(url, options, (res) => {
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (!location) return reject(new Error("Redirect without location"));
        fetchJson(location).then(resolve).catch(reject);
        res.resume();
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }

      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Invalid JSON from ${url}`));
        }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

function followRedirects(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith("https") ? httpsGet : httpGet;
    getter(url, { headers: { "User-Agent": "token-pilot" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (!location) return reject(new Error("Redirect without location"));
        res.resume();
        followRedirects(location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(
          new Error(`HTTP ${res.statusCode} downloading from ${url}`),
        );
      }
      resolve(res);
    }).on("error", reject);
  });
}

async function downloadAndExtractTarGz(
  url: string,
  destDir: string,
  binaryName: string,
): Promise<void> {
  const res = await followRedirects(url);
  const gunzip = createGunzip();

  // Pipe through gunzip, then our custom tar extractor
  const chunks: Buffer[] = [];
  res.pipe(gunzip);

  await new Promise<void>((resolve, reject) => {
    gunzip.on("data", (chunk: Buffer) => chunks.push(chunk));
    gunzip.on("end", resolve);
    gunzip.on("error", reject);
    res.on("error", reject);
  });

  const tarData = Buffer.concat(chunks);
  await tarExtract(tarData, destDir, binaryName);
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await followRedirects(url);
  const fileStream = createWriteStream(destPath);
  await pipeline(res, fileStream);
}
