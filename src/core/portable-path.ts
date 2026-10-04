/**
 * Path helpers for code that also runs inside a Claude Code mod, which has
 * no node:path. Accepts `/` and `\`, returns `/`-separated paths and keeps a
 * Windows drive prefix — Node and Claude Code accept forward slashes on
 * Windows, and a UNC share's `//server/share/` root. Windows paths (drive or UNC)
 * compare case-insensitively, POSIX paths exactly — as node:path does on
 * each platform.
 */

const DRIVE = /^[A-Za-z]:/;
// A share needs both names; a lone leading "//" is a POSIX root, as in node:path.
const UNC = /^\/\/[^/]+\/[^/]+/;

export function toSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

export function isAbsolute(p: string): boolean {
  const s = toSlash(p);
  return s.startsWith("/") || /^[A-Za-z]:\//.test(s);
}

function split(p: string): { root: string; parts: string[] } {
  const s = toSlash(p);
  const share = UNC.exec(s)?.[0];
  if (share) return { root: `${share}/`, parts: s.slice(share.length).split("/").filter(Boolean) };

  const drive = DRIVE.exec(s)?.[0] ?? "";
  const rest = s.slice(drive.length);
  const root = drive + (rest.startsWith("/") ? "/" : "");

  return { root, parts: rest.split("/").filter(Boolean) };
}

export function normalize(p: string): string {
  const { root, parts } = split(p);
  const out: string[] = [];

  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!root) out.push("..");
      continue;
    }
    out.push(part);
  }

  return root + out.join("/") || ".";
}

// One separator between parts: "/" + "a" must not become "//a", a share.
function glue(a: string, b: string): string {
  return a === "" ? b : `${a.replace(/[\\/]+$/, "")}/${b.replace(/^[\\/]+/, "")}`;
}

export function resolve(base: string, ...paths: string[]): string {
  let acc = base;
  for (const p of paths) acc = isAbsolute(p) ? p : glue(acc, p);

  return normalize(acc);
}

export function relative(from: string, to: string): string {
  const a = split(normalize(from));
  const b = split(normalize(to));
  if (a.root.toLowerCase() !== b.root.toLowerCase()) return normalize(to);

  // Windows (drive or UNC) is case-insensitive; POSIX is not.
  const fold = a.root !== "/" && a.root !== "";
  const same = (x: string, y: string) => (fold ? x.toLowerCase() === y.toLowerCase() : x === y);

  let i = 0;
  while (i < a.parts.length && i < b.parts.length && same(a.parts[i], b.parts[i])) i++;

  return [...a.parts.slice(i).map(() => ".."), ...b.parts.slice(i)].join("/");
}

export function dirname(p: string): string {
  const { root, parts } = split(normalize(p));
  return root + parts.slice(0, -1).join("/") || ".";
}

export function join(...parts: string[]): string {
  return normalize(parts.reduce(glue, ""));
}
