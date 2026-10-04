/**
 * Builds a FileStructure from ast-index outline entries plus the file source.
 *
 * ast-index gives start lines only, and prints every symbol at the same
 * indent. Real ranges and nesting therefore come from the source:
 *   - brace languages: the block that the declaration opens, found on a copy
 *     of the source with comments, strings, template literals and regex
 *     literals blanked out;
 *   - Python: indentation;
 *   - anything else: up to the next symbol (heuristic).
 * Leading doc comments, decorators/annotations and TS overload signatures
 * belong to the symbol they precede. Nesting is rebuilt from the ranges.
 */

import { stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ExportDeclaration, FileStructure, ImportDeclaration, SymbolInfo } from '../types.js';
import type { AstIndexOutlineEntry } from './types.js';
import { detectLanguage, mapOutlineEntry } from './parser.js';

const BRACE_LANGUAGES = new Set([
  'TypeScript', 'JavaScript', 'Go', 'Rust', 'Java', 'Kotlin', 'C#', 'PHP',
  'Swift', 'Scala', 'Dart', 'C', 'C++',
]);
const JS_LANGUAGES = new Set(['TypeScript', 'JavaScript']);
const HASH_COMMENT_LANGUAGES = new Set(['Python', 'PHP', 'Ruby', 'Bash', 'Perl', 'Elixir', 'R']);
/** Languages whose "..." / '...' literals end at the end of the line. */
const SINGLE_LINE_QUOTES = new Set([
  'TypeScript', 'JavaScript', 'Java', 'C#', 'C', 'C++', 'Go', 'Kotlin', 'Swift', 'Scala', 'Dart', 'Python',
]);
const TRIPLE_DOUBLE_QUOTES = new Set(['Python', 'Kotlin', 'Java', 'Swift', 'Scala', 'C#', 'Dart', 'Elixir']);
const TRIPLE_SINGLE_QUOTES = new Set(['Python', 'Dart']);
const REGEX_PREFIX_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);
/** After a `{…}` block these mean the declaration goes on (return type, `=>`, union, `= value`). */
const CONTINUES_AFTER_BLOCK = new Set(['{', '=', '>', '|', '&', ':', '.']);
/** A Go line ending in one of these continues on the next line. */
const GO_CONTINUATION = new Set([',', '(', '[', '=', '+', '-', '*', '/', '&', '|', '.', ':', '<', '>', '!', '^', '%']);
const TEST_FILE_RE = /(^|[\\/])(__tests__|tests?)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$/;
const SIGNATURE_MAX = 200;

/** Lines in a file: a trailing newline ends the last line, it does not start a new one. */
export function countLines(content: string): number {
  if (content === '') return 0;
  const n = content.split('\n').length;
  return content.endsWith('\n') ? n - 1 : n;
}

export async function buildFileStructure(
  filePath: string,
  entries: AstIndexOutlineEntry[],
): Promise<FileStructure> {
  const content = await readFile(filePath, 'utf-8');
  const fileStat = await stat(filePath);
  const lang = detectLanguage(filePath);
  const src = new Source(content, lang, /\.[jt]sx$/i.test(filePath));
  const symbols = buildSymbols(entries, src, lang, filePath);

  return {
    path: filePath,
    language: lang,
    meta: {
      lines: countLines(content),
      bytes: fileStat.size,
      lastModified: fileStat.mtimeMs,
      contentHash: createHash('sha256').update(content).digest('hex'),
    },
    imports: parseImports(src, lang),
    exports: collectExports(src, lang, symbols),
    symbols,
  };
}

// ─── Source with comments / strings blanked ─────────────────────────────

class Source {
  readonly code: string;
  readonly rawLines: string[];
  readonly lineStarts: number[];
  /** Per line (0-based): only comment text, no code and no string. */
  readonly commentOnly: boolean[];
  /** Per line (0-based): the line starts inside a multi-line string. */
  readonly startsInString: boolean[];
  /** Per offset: the matching bracket of the same type, or -1. */
  readonly match: Int32Array;
  /** Per line (0-based): `{` nesting depth at the start of the line. */
  readonly braceDepth: Int32Array;

  constructor(readonly raw: string, readonly lang: string, jsx = false) {
    this.rawLines = raw.split('\n');
    this.lineStarts = [0];
    for (let k = 0; k < raw.length; k++) if (raw.charCodeAt(k) === 10) this.lineStarts.push(k + 1);

    const masked = maskSource(raw, lang, jsx);
    const chars = raw.split('');
    const commentLine = new Uint8Array(this.lineStarts.length);
    const stringLine = new Uint8Array(this.lineStarts.length);
    this.startsInString = new Array(this.lineStarts.length).fill(false);
    for (const [s, e, isString] of masked) {
      let line = this.lineOf(s) - 1;
      const flags = isString ? stringLine : commentLine;
      for (let k = s; k < e; k++) {
        if (chars[k] === '\n') {
          line++;
          if (isString) this.startsInString[line] = true;
        } else {
          chars[k] = ' ';
          flags[line] = 1;
        }
      }
    }
    this.code = chars.join('');

    const codeLines = this.code.split('\n');
    this.commentOnly = codeLines.map((l, i) => commentLine[i] === 1 && stringLine[i] === 0 && l.trim() === '');

    const n = this.code.length;
    this.match = new Int32Array(n).fill(-1);
    this.braceDepth = new Int32Array(this.lineStarts.length);
    const stacks: Record<string, number[]> = { '{': [], '(': [], '[': [] };
    const closers: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
    let line = 0;
    for (let k = 0; k < n; k++) {
      const ch = this.code[k];
      if (ch === '\n') {
        this.braceDepth[++line] = stacks['{'].length;
      } else if (ch === '{' || ch === '(' || ch === '[') {
        stacks[ch].push(k);
      } else if (ch === '}' || ch === ')' || ch === ']') {
        const open = stacks[closers[ch]].pop();
        if (open !== undefined) {
          this.match[open] = k;
          this.match[k] = open;
        }
      }
    }
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  /** 1-based line of an offset. */
  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** Blanked text of a 1-based line. */
  codeLine(line: number): string {
    const s = this.lineStarts[line - 1];
    const e = line < this.lineStarts.length ? this.lineStarts[line] - 1 : this.code.length;
    return this.code.slice(s, e);
  }

  rawLine(line: number): string {
    return this.rawLines[line - 1] ?? '';
  }

  nextCodeIndex(offset: number): number {
    let k = offset;
    while (k < this.code.length && isSpace(this.code[k])) k++;
    return k;
  }

  prevCodeIndex(offset: number): number {
    let k = offset - 1;
    while (k >= 0 && isSpace(this.code[k])) k--;
    return k;
  }

  /** Line of the last code character before `offset`, never above `minLine`. */
  lastCodeLine(offset: number, minLine: number): number {
    const k = this.prevCodeIndex(offset);
    return k < 0 ? minLine : Math.max(minLine, this.lineOf(k));
  }
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r';
}

function isWordChar(ch: string): boolean {
  return /[\w$]/.test(ch);
}

/**
 * Ranges of comments (false) and string/regex literals (true) to blank out.
 * Code inside JS template interpolations `${…}` stays visible; the `${` and
 * its closing `}` are blanked so they never count as a block. In JSX/TSX
 * `</tag>` and `/>` are tags, never the start of a regex literal.
 */
function maskSource(raw: string, lang: string, jsx = false): Array<[number, number, boolean]> {
  const js = JS_LANGUAGES.has(lang);
  const go = lang === 'Go';
  const hashComments = HASH_COMMENT_LANGUAGES.has(lang);
  const slashComments = lang !== 'Python' && (BRACE_LANGUAGES.has(lang) || !hashComments);
  const singleLine = SINGLE_LINE_QUOTES.has(lang);
  const tripleDq = TRIPLE_DOUBLE_QUOTES.has(lang);
  const tripleSq = TRIPLE_SINGLE_QUOTES.has(lang);
  const n = raw.length;
  const out: Array<[number, number, boolean]> = [];
  const interpolation: number[] = [];
  let prevSig = '';
  let prevWord = '';

  const eol = (from: number): number => {
    const k = raw.indexOf('\n', from);
    return k < 0 ? n : k;
  };

  /** From just after "`" or an interpolation's "}" to after "`" or "${". */
  const scanTemplate = (from: number): number => {
    for (let j = from; j < n; j++) {
      const ch = raw[j];
      if (ch === '\\') { j++; continue; }
      if (ch === '`') return j + 1;
      if (ch === '$' && raw[j + 1] === '{') {
        interpolation.push(0);
        return j + 2;
      }
    }
    return n;
  };

  /** End of a quoted literal, or -1 when it is not one (unterminated in JS). */
  const scanQuoted = (i: number, q: string): number => {
    if ((q === '"' ? tripleDq : tripleSq) && raw[i + 1] === q && raw[i + 2] === q) {
      for (let j = i + 3; j < n; j++) {
        if (raw[j] === '\\') { j++; continue; }
        if (raw[j] === q && raw[j + 1] === q && raw[j + 2] === q) return j + 3;
      }
      return n;
    }
    for (let j = i + 1; j < n; j++) {
      const ch = raw[j];
      if (ch === '\\') { j++; continue; }
      if (ch === q) return j + 1;
      if (ch === '\n' && singleLine) return js ? -1 : j;
    }
    return js ? -1 : n;
  };

  const scanRegex = (i: number): number => {
    let inClass = false;
    for (let j = i + 1; j < n; j++) {
      const ch = raw[j];
      if (ch === '\n') return -1;
      if (ch === '\\') { j++; continue; }
      if (inClass) {
        if (ch === ']') inClass = false;
      } else if (ch === '[') {
        inClass = true;
      } else if (ch === '/') {
        let k = j + 1;
        while (k < n && /[a-z]/i.test(raw[k])) k++;
        return k;
      }
    }
    return -1;
  };

  let i = 0;
  while (i < n) {
    const c = raw[i];
    const d = raw[i + 1];
    if (isSpace(c)) { i++; continue; }

    if (slashComments && c === '/' && d === '/') {
      const e = eol(i);
      out.push([i, e, false]);
      i = e;
      continue;
    }
    if (slashComments && c === '/' && d === '*') {
      const k = raw.indexOf('*/', i + 2);
      const e = k < 0 ? n : k + 2;
      out.push([i, e, false]);
      i = e;
      continue;
    }
    if (hashComments && c === '#' && !(lang === 'PHP' && d === '[')) {
      const e = eol(i);
      out.push([i, e, false]);
      i = e;
      continue;
    }

    if (c === '"' || c === "'" || (c === '`' && (js || go))) {
      // Rust lifetimes ('a) are not char literals
      if (c === "'" && lang === 'Rust' && d !== '\\' && raw[i + 2] !== "'") {
        prevSig = c;
        i++;
        continue;
      }
      let e: number;
      if (c === '`' && js) e = scanTemplate(i + 1);
      else if (c === '`') { const k = raw.indexOf('`', i + 1); e = k < 0 ? n : k + 1; }
      else e = scanQuoted(i, c);
      if (e < 0) {
        prevSig = c;
        i++;
        continue;
      }
      out.push([i, e, true]);
      prevSig = 'a';
      prevWord = '';
      i = e;
      continue;
    }

    if (js && c === '/') {
      const tag = jsx && (prevSig === '<' || d === '>');
      const allowed = !tag && (prevSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prevSig)
        || (prevSig === 'a' && REGEX_PREFIX_WORDS.has(prevWord)));
      const e = allowed ? scanRegex(i) : -1;
      if (e > 0) {
        out.push([i, e, true]);
        prevSig = 'a';
        prevWord = '';
        i = e;
        continue;
      }
    }

    if (js && interpolation.length > 0) {
      const top = interpolation.length - 1;
      if (c === '{') interpolation[top]++;
      else if (c === '}') {
        if (interpolation[top] === 0) {
          interpolation.pop();
          const e = scanTemplate(i + 1);
          out.push([i, e, true]);
          prevSig = 'a';
          i = e;
          continue;
        }
        interpolation[top]--;
      }
    }

    if (isWordChar(c)) {
      let j = i + 1;
      while (j < n && isWordChar(raw[j])) j++;
      prevWord = raw.slice(i, j);
      prevSig = 'a';
      i = j;
      continue;
    }

    prevSig = c;
    prevWord = '';
    i++;
  }
  return out;
}

// ─── Symbols ────────────────────────────────────────────────────────────

interface Sym {
  entry: AstIndexOutlineEntry;
  /** Line of the declaration itself (1-based). */
  decl: number;
  /** First line including leading docs / decorators / overloads. */
  start: number;
  end: number;
  /** Offset where the forward scan for the body starts. */
  from: number;
  qualified?: string;
  doc?: string;
  children: Sym[];
}

function buildSymbols(
  entries: AstIndexOutlineEntry[],
  src: Source,
  lang: string,
  filePath: string,
): SymbolInfo[] {
  const brace = BRACE_LANGUAGES.has(lang);

  const syms: Sym[] = [];
  const seen = new Set<string>();
  const add = (entry: AstIndexOutlineEntry, from?: number): void => {
    const decl = entry.start_line;
    if (decl < 1 || decl > src.lineCount) return;
    const key = `${decl}:${entry.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    syms.push({
      entry: { ...entry, children: undefined },
      decl,
      start: decl,
      end: decl,
      from: from ?? src.lineStarts[decl - 1] + wordIndex(src.codeLine(decl), entry.name),
      children: [],
    });
  };

  const walk = (list: AstIndexOutlineEntry[]): void => {
    for (const e of list) {
      // ast-index lists decorators/annotations as their own entries
      if (e.kind.toLowerCase() !== 'annotation') add(normalizeEntry(e, src, lang));
      if (e.children?.length) walk(e.children);
    }
  };
  walk(entries);
  for (const [entry, from] of supplementEntries(src, lang, filePath, new Set(syms.map((s) => s.decl)))) add(entry, from);

  syms.sort((a, b) => a.decl - b.decl);

  // Leading docs, decorators and overloads (bounded by the previous declaration)
  for (let i = 0; i < syms.length; i++) {
    attachLeading(syms[i], src, lang, i > 0 ? syms[i - 1].decl : 0);
  }

  // End lines
  for (let i = 0; i < syms.length; i++) {
    const sym = syms[i];
    let k = i + 1;
    while (k < syms.length && syms[k].decl === sym.decl) k++;
    const next = syms[k];
    const limit = next ? src.lineStarts[next.start - 1] : src.code.length;
    let end = -1;
    if (brace) end = braceEnd(src, sym, limit, lang === 'Go');
    else if (lang === 'Python') end = indentEnd(src, sym.decl);
    if (end < 0) end = src.lastCodeLine(limit, sym.decl);
    sym.end = Math.max(end, sym.decl);
  }

  for (const sym of syms) {
    applyModifiers(sym, src, lang);
    if (lang === 'Python' && !sym.doc) sym.doc = pythonDocstring(src, sym);
  }
  const roots = nest(syms);
  if (lang === 'Python') markPythonMembers(roots);
  return roots.map((s) => toSymbolInfo(s, src, ''));
}

/** Index of `name` as a whole word in `line`, or 0. */
function wordIndex(line: string, name: string): number {
  let k = line.indexOf(name);
  while (k >= 0) {
    const before = k === 0 ? '' : line[k - 1];
    const after = line[k + name.length] ?? '';
    if (!isWordChar(before) && !isWordChar(after)) return k;
    k = line.indexOf(name, k + 1);
  }
  return 0;
}

/** Language-specific fixes of what ast-index reports. */
function normalizeEntry(e: AstIndexOutlineEntry, src: Source, lang: string): AstIndexOutlineEntry {
  const line = src.codeLine(e.start_line);
  // Rust: "impl Foo" / "impl<T> Display for Foo<T>" → owner type "Foo"
  if (lang === 'Rust' && e.name.startsWith('impl')) {
    const m = e.name.match(/^impl(?:<.*>)?\s+(?:.*\sfor\s+)?([\w:]+)/);
    if (m) return { ...e, name: m[1].split('::').pop()! };
  }
  // JS/TS: `export default defineConfig({...})` is the default export, not a declaration of defineConfig
  if (JS_LANGUAGES.has(lang) && new RegExp(`\\bexport\\s+default\\s+${escapeRe(e.name)}\\s*\\(`).test(line)) {
    return { ...e, name: 'default', kind: 'variable' };
  }
  return e;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Declarations ast-index does not report, as [entry, scan offset]. */
function supplementEntries(
  src: Source,
  lang: string,
  filePath: string,
  known: Set<number>,
): Array<[AstIndexOutlineEntry, number | undefined]> {
  const out: Array<[AstIndexOutlineEntry, number | undefined]> = [];
  const isTest = JS_LANGUAGES.has(lang) && TEST_FILE_RE.test(filePath);

  for (let line = 1; line <= src.lineCount; line++) {
    if (known.has(line)) continue;
    const code = src.codeLine(line);
    let m: RegExpMatchArray | null;

    if (JS_LANGUAGES.has(lang)) {
      if (src.braceDepth[line - 1] === 0 && (m = code.match(/^\s*export\s+(?:declare\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)/))) {
        out.push([{ name: m[2], kind: m[1] === 'const' ? 'constant' : 'variable', start_line: line, end_line: 0 }, undefined]);
      } else if ((m = code.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*\s*([A-Za-z_$][\w$]*)/))) {
        out.push([{ name: m[1], kind: 'function', start_line: line, end_line: 0 }, undefined]);
      } else if (isTest && (m = code.match(/^(\s*)(describe|suite|it|test)(?:\.\w+)*\s*\(/))) {
        const callAt = src.lineStarts[line - 1] + m[1].length;
        const title = literalAfter(src, src.lineStarts[line - 1] + m[0].length);
        if (title !== null) {
          const kind = m[2] === 'describe' || m[2] === 'suite' ? 'namespace' : 'function';
          out.push([{ name: title, kind, start_line: line, end_line: 0 }, callAt]);
        }
      }
    } else if (lang === 'Python') {
      if ((m = code.match(/^\s*(?:async\s+)?def\s+(\w+)\s*[([]/)) || (m = code.match(/^\s*class\s+(\w+)/))) {
        const kind = /^\s*class\s/.test(code) ? 'class' : 'function';
        out.push([{ name: m[1], kind, start_line: line, end_line: 0 }, undefined]);
      }
    } else if (lang === 'PHP') {
      if ((m = code.match(/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+(\w+)\s*\(/))) {
        out.push([{ name: m[1], kind: 'function', start_line: line, end_line: 0 }, undefined]);
      }
    }
  }
  return out;
}

/** The string literal starting at (or right after spaces from) `offset`, or null. */
function literalAfter(src: Source, offset: number): string | null {
  let k = offset;
  while (k < src.raw.length && isSpace(src.raw[k])) k++;
  const q = src.raw[k];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  const end = src.raw.indexOf(q, k + 1);
  if (end < 0) return null;
  return src.raw.slice(k + 1, end);
}

function isDecoratorLine(code: string, lang: string): boolean {
  if (code.startsWith('@')) return lang !== 'Go' && lang !== 'C' && lang !== 'C++';
  if (code.startsWith('#[')) return lang === 'Rust' || lang === 'PHP';
  if (lang === 'C#') return /^\[[A-Za-z_][\w.]*\s*(\(|\]|,)/.test(code);
  return false;
}

function attachLeading(sym: Sym, src: Source, lang: string, floor: number): void {
  const decorators: string[] = [];
  const docLines: string[] = [];
  let line = sym.decl - 1;

  while (line > floor && line >= 1) {
    if (src.rawLine(line).trim() === '') break;

    if (src.commentOnly[line - 1]) {
      docLines.unshift(src.rawLine(line).trim());
      sym.start = line;
      line--;
      continue;
    }

    const code = src.codeLine(line).trim();
    // multi-line decorator / attribute: jump to the line holding its opener
    let open = line;
    const last = code[code.length - 1];
    if (last === ')' || last === ']') {
      const closeAt = src.lineStarts[line - 1] + src.codeLine(line).lastIndexOf(last);
      const o = src.match[closeAt];
      if (o >= 0) open = src.lineOf(o);
    }
    const head = src.codeLine(open).trim();
    if (open > floor && isDecoratorLine(head, lang)) {
      decorators.unshift(src.rawLine(open).trim().replace(/^@|^#\[|^\[/, '').replace(/\]$/, ''));
      sym.start = open;
      line = open - 1;
      continue;
    }

    if (lang === 'TypeScript' && code.endsWith(';')) {
      const s = overloadStart(src, line, sym.entry.name, floor);
      if (s > 0) {
        sym.start = s;
        line = s - 1;
        continue;
      }
    }
    break;
  }

  if (decorators.length > 0) sym.entry.decorators = decorators;
  const doc = docText(docLines);
  if (doc) sym.doc = doc;
}

/** First line of a TS overload signature of `name` ending on `line`, or 0. */
function overloadStart(src: Source, line: number, name: string, floor: number): number {
  const re = new RegExp(
    `^(?:export\\s+)?(?:declare\\s+)?(?:default\\s+)?(?:(?:public|private|protected|static|abstract|override|readonly|async)\\s+)*(?:function\\s*\\*?\\s*)?${escapeRe(name)}\\s*[<(?]`,
  );
  for (let s = line; s > floor && s >= line - 30; s--) {
    const t = src.codeLine(s).trim();
    if (re.test(t)) return s;
    if (s < line && (t === '' || /[;{}]$/.test(t))) return 0;
  }
  return 0;
}

function docText(lines: string[]): string | undefined {
  for (const l of lines) {
    const t = l.replace(/^(\/\*\*?|\*\/|\*|\/\/\/?|#)\s?/, '').replace(/\*\/$/, '').trim();
    if (t && !t.startsWith('@')) return t;
  }
  return undefined;
}

/**
 * End of a declaration in a brace language: the block it opens, the `;` that
 * ends it, or the last code line before the enclosing block closes / the next
 * symbol starts. -1 when the braces do not balance.
 */
function braceEnd(src: Source, sym: Sym, limit: number, go: boolean): number {
  const code = src.code;
  const n = code.length;
  let paren = 0;
  let bracket = 0;
  let j = sym.from;

  while (j < n) {
    const ch = code[j];
    // passed the next symbol while nested: that symbol is inside this declaration
    if (j >= limit && (paren > 0 || bracket > 0)) limit = n + 1;
    if (paren === 0 && bracket === 0) {
      if (j >= limit) return src.lastCodeLine(limit, sym.decl);
      if (ch === '{') {
        const close = src.match[j];
        if (close < 0) return -1;
        if (close >= limit) limit = n + 1;
        const k = src.nextCodeIndex(close + 1);
        const after = code[k];
        const arrayType = after === '[' && code[src.nextCodeIndex(k + 1)] === ']';
        if (k < limit && k < n && (CONTINUES_AFTER_BLOCK.has(after) || arrayType)) {
          j = k;
          continue;
        }
        return src.lineOf(close);
      }
      if (ch === ';') return src.lineOf(j);
      if (ch === '}' || ch === ')' || ch === ']') return src.lastCodeLine(j, sym.decl);
      if (go && ch === '\n') {
        const p = src.prevCodeIndex(j);
        if (p >= sym.from && !GO_CONTINUATION.has(code[p])) return src.lineOf(p);
      }
    }
    if (ch === '(') paren++;
    else if (ch === ')') { if (paren > 0) paren--; }
    else if (ch === '[') bracket++;
    else if (ch === ']') { if (bracket > 0) bracket--; }
    else if (ch === '{') {
      // a block inside (...) or [...] — skip it whole
      const close = src.match[j];
      if (close > j) { j = close + 1; continue; }
    }
    j++;
  }
  return src.lastCodeLine(n, sym.decl);
}

/** Python: the block is every following line indented deeper than the header. */
function indentEnd(src: Source, decl: number): number {
  const indentOf = (line: number): number => src.rawLine(line).match(/^[ \t]*/)![0].length;
  const delta = (s: string): number => {
    let d = 0;
    for (const ch of s) {
      if (ch === '(' || ch === '[' || ch === '{') d++;
      else if (ch === ')' || ch === ']' || ch === '}') d--;
    }
    return d;
  };
  const indent = indentOf(decl);
  let depth = Math.max(0, delta(src.codeLine(decl)));
  let end = decl;

  for (let line = decl + 1; line <= src.lineCount; line++) {
    const code = src.codeLine(line);
    const continuation = depth > 0 || src.startsInString[line - 1];
    depth = Math.max(0, depth + delta(code));
    if (continuation) {
      end = line;
      continue;
    }
    if (src.rawLine(line).trim() === '' || src.commentOnly[line - 1]) continue;
    if (indentOf(line) <= indent) break;
    end = line;
  }
  return end;
}

function applyModifiers(sym: Sym, src: Source, lang: string): void {
  const e = sym.entry;
  const line = src.codeLine(sym.decl);
  const before = line.slice(0, Math.max(0, sym.from - src.lineStarts[sym.decl - 1]));

  if (lang === 'Python') {
    if (/^\s*async\s+def\b/.test(line)) e.is_async = true;
    if (e.decorators?.includes('staticmethod')) e.is_static = true;
    return;
  }
  if (!BRACE_LANGUAGES.has(lang)) return;

  const vis = before.match(/\b(public|private|protected)\b/);
  if (vis) e.visibility = vis[1];
  else if (lang === 'Rust' && /\bpub\b/.test(before)) e.visibility = 'public';
  if (/\bstatic\b/.test(before)) e.is_static = true;
  if (/\basync\b/.test(before)) e.is_async = true;

  if (e.kind.toLowerCase() === 'function') {
    // Go: func (s *Server) Start() → method Server.Start
    const recv = lang === 'Go' ? line.match(/^\s*func\s*\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)/) : null;
    if (recv) {
      e.kind = 'method';
      sym.qualified = `${recv[1]}.${e.name}`;
    }
  }
}

/** Build the tree: a symbol whose range lies inside another's becomes its child. */
function nest(syms: Sym[]): Sym[] {
  const order = syms
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.start - b.s.start || b.s.end - a.s.end || a.i - b.i)
    .map((x) => x.s);
  const roots: Sym[] = [];
  const stack: Sym[] = [];
  for (const sym of order) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (sym.start >= top.start && sym.end <= top.end && sym.decl > top.decl) break;
      stack.pop();
    }
    if (stack.length > 0) stack[stack.length - 1].children.push(sym);
    else roots.push(sym);
    stack.push(sym);
  }
  return roots;
}

/** Python: underscore names inside a class are protected/private. */
function markPythonMembers(syms: Sym[], inClass = false): void {
  for (const s of syms) {
    if (inClass) {
      const name = s.entry.name;
      if (name.startsWith('__') && !name.endsWith('__')) s.entry.visibility = 'private';
      else if (name.startsWith('_') && !name.startsWith('__')) s.entry.visibility = 'protected';
    }
    markPythonMembers(s.children, s.entry.kind.toLowerCase() === 'class');
  }
}

function toSymbolInfo(sym: Sym, src: Source, parent: string): SymbolInfo {
  const raw = src.rawLine(sym.decl).trim();
  const entry: AstIndexOutlineEntry = {
    ...sym.entry,
    start_line: sym.start,
    end_line: sym.end,
    signature: sym.entry.signature ?? (raw.length > SIGNATURE_MAX ? `${raw.slice(0, SIGNATURE_MAX)}…` : raw),
    doc: sym.entry.doc ?? sym.doc,
    children: undefined,
  };
  const info = mapOutlineEntry(entry);
  info.qualifiedName = sym.qualified ?? (parent ? `${parent}.${sym.entry.name}` : sym.entry.name);
  info.children = sym.children.map((c) => toSymbolInfo(c, src, info.qualifiedName));
  return info;
}

/** First line of the docstring right under a Python def/class header. */
function pythonDocstring(src: Source, sym: Sym): string | undefined {
  const indent = src.rawLine(sym.decl).match(/^[ \t]*/)![0].length;
  for (let line = sym.decl + 1; line <= sym.end; line++) {
    const raw = src.rawLine(line);
    if (raw.trim() === '' || src.commentOnly[line - 1]) continue;
    if (raw.match(/^[ \t]*/)![0].length <= indent) return undefined;
    const m = raw.trim().match(/^[rRuUbB]?("""|'''|"|')(.*)$/);
    if (!m) return undefined;
    const text = m[2].replace(/("""|'''|"|')\s*$/, '').trim();
    return text || src.rawLine(line + 1).trim() || undefined;
  }
  return undefined;
}

// ─── Imports / exports ──────────────────────────────────────────────────

/** Top-level imports of the file. */
function parseImports(src: Source, lang: string): ImportDeclaration[] {
  const out: ImportDeclaration[] = [];
  const add = (source: string, specifiers: string[], line: number, isDefault = false, isNamespace = false): void => {
    out.push({ source, specifiers, isDefault, isNamespace, line });
  };

  if (JS_LANGUAGES.has(lang)) {
    const re = /^[ \t]*import\s+(?:type\s+)?(?:([^'";]*?)\s+from\s+)?(['"])([^'"\n]+)\2/gm;
    for (const m of src.raw.matchAll(re)) {
      const at = m.index! + m[0].indexOf('import');
      const line = src.lineOf(at);
      if (src.code[at] !== 'i' || src.braceDepth[line - 1] !== 0) continue; // in a comment, string or block
      const clause = (m[1] ?? '').trim();
      const source = m[3];
      if (!clause) {
        add(source, [], line);
        continue;
      }
      const def = clause.match(/^([\w$]+)\s*(,|$)/);
      const ns = clause.match(/\*\s*as\s+([\w$]+)/);
      const named = clause.match(/\{([^}]*)\}/);
      if (def) add(source, [def[1]], line, true);
      if (ns) add(source, [ns[1]], line, false, true);
      if (named) {
        const names = named[1].split(',')
          .map((x) => x.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim())
          .filter(Boolean);
        add(source, names, line);
      }
    }
    return out;
  }

  const quoted = (line: number): string | undefined => src.rawLine(line).match(/["'<]([^"'>]+)["'>]/)?.[1];
  for (let line = 1; line <= src.lineCount; line++) {
    if (src.braceDepth[line - 1] !== 0) continue;
    const code = src.codeLine(line);
    let m: RegExpMatchArray | null;
    if (lang === 'Python') {
      if ((m = code.match(/^import\s+(.+)$/))) {
        for (const part of m[1].split(',')) {
          const [mod, alias] = part.trim().split(/\s+as\s+/);
          if (mod) add(mod, [alias ?? mod], line, true);
        }
      } else if ((m = code.match(/^from\s+([\w.]+)\s+import\s+\(?([^)]*)\)?/))) {
        add(m[1], m[2].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()!).filter(Boolean), line);
      }
    } else if (lang === 'Go') {
      if (/^import\s*\(/.test(code)) {
        const open = src.lineStarts[line - 1] + code.indexOf('(');
        const close = src.match[open] >= 0 ? src.lineOf(src.match[open]) : line;
        for (let l = line + 1; l < close; l++) {
          const q = quoted(l);
          if (q) add(q, [], l);
        }
        line = close;
      } else if (/^import\s/.test(code)) {
        const q = quoted(line);
        if (q) add(q, [], line);
      }
    } else if (lang === 'C' || lang === 'C++' || lang === 'Dart') {
      if (/^\s*(#\s*include|import)\b/.test(code)) {
        const q = quoted(line);
        if (q) add(q, [], line);
      }
    } else if ((m = code.match(
      lang === 'Rust' ? /^\s*(?:pub\s+)?use\s+([^;]+);/
        : lang === 'PHP' ? /^\s*use\s+([\w\\]+)/
          : lang === 'C#' ? /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/
            : /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)/,
    ))) {
      add(m[1].trim(), [], line);
    }
  }
  return out;
}

/** What the file exposes: `export` in JS/TS, public names elsewhere. */
function collectExports(src: Source, lang: string, symbols: SymbolInfo[]): ExportDeclaration[] {
  const out: ExportDeclaration[] = [];
  const add = (name: string, kind: SymbolInfo['kind'], line: number, isDefault = false): void => {
    if (!out.some((e) => e.name === name)) out.push({ name, kind, isDefault, line });
  };
  const byName = (name: string): SymbolInfo | undefined => symbols.find((s) => s.name === name);

  if (JS_LANGUAGES.has(lang)) {
    for (const s of symbols) {
      if (/^export\b/.test(s.signature)) add(s.name, s.kind, s.location.startLine, /^export\s+default\b/.test(s.signature));
    }
    for (let line = 1; line <= src.lineCount; line++) {
      if (src.braceDepth[line - 1] !== 0) continue;
      const code = src.codeLine(line);
      const list = code.match(/^\s*export\s+(?:type\s+)?\{([^}]*)\}/);
      if (list) {
        for (const part of list[1].split(',')) {
          const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
          if (name) add(name, byName(name)?.kind ?? 'variable', line, name === 'default');
        }
      }
      const def = code.match(/^\s*export\s+default\s+([\w$]+)\s*;?\s*$/);
      if (def) add(def[1], byName(def[1])?.kind ?? 'variable', line, true);
    }
    return out;
  }

  for (const s of symbols) {
    if (s.kind === 'namespace') continue;
    const name = s.name;
    const exported = lang === 'Python' ? !name.startsWith('_')
      : lang === 'Go' ? /^[A-Z]/.test(name)
        : lang === 'Rust' ? s.visibility === 'public'
          : s.visibility !== 'private' && s.visibility !== 'protected';
    if (exported) add(name, s.kind, s.location.startLine);
  }
  return out;
}
