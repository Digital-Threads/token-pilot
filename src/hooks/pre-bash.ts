/**
 * PreToolUse:Bash gate — refuses a heavy shell command BEFORE it runs.
 *
 * Why before: Claude Code's PostToolUse hook cannot truncate a Bash result,
 * so once a command ran its whole stdout already sits in the agent's
 * context. The only saving is refusing the call up front.
 *
 * Policy (1.0.2):
 *  - Block only clear, unbounded dumps of code: a whole code file (`cat`,
 *    `less`, a slice over the Read gate's threshold), recursive search,
 *    unbounded `git log` / `git diff` / `git show`, `find` over the whole
 *    disk or the whole repository.
 *  - Allow anything bounded: a small slice, `-m`/`-l`/`-c`, a path scope,
 *    output redirected to a file, or piped into anything but a pass-through
 *    (`head`, `wc`, `grep` …). Only `cat`/`sort`/`tee`-like sinks keep a
 *    dump a dump.
 *  - Judge each segment of a compound command (`&&` `||` `;` `|` `( )`)
 *    with its own arguments only. Words are read the way the shell reads
 *    them: quotes removed, heredoc bodies and comments skipped, env prefixes
 *    and `sudo`/`env`/`time` wrappers stripped, `bash -c` / `eval` scripts
 *    and `for` loop variables expanded.
 *  - TOKEN_PILOT_BYPASS=1, in the hook's environment or as a prefix on the
 *    command, lets everything through.
 *  - When in doubt, allow: a false block costs more than a missed one.
 *
 * Pure and Node-free: the command hook and the Claude Code mod share it.
 */

import type { EnforcementMode } from "../server/enforcement-mode.js";
import { toolPrefix } from "../core/tool-names.js";
import { isCodeFile } from "./read-gate.js";

export interface PreBashInput {
  tool_name?: string;
  tool_input?: {
    command?: string;
    [k: string]: unknown;
  };
}

export type PreBashDecision =
  | { kind: "allow" }
  | { kind: "advise"; reason: string }
  | { kind: "deny"; reason: string };

export interface PreBashOptions {
  /** TOKEN_PILOT_BYPASS=1 in the hook's own environment. */
  bypass?: boolean;
  /** The project root: a `find` outside it walks someone else's disk. */
  projectRoot?: string;
}

/** A slice of a code file larger than this is a whole-file dump in disguise (the Read gate's default threshold). */
const SLICE_DENY_LINES = 300;
/** The same for byte counts (`head -c`): about 300 lines of code. */
const SLICE_DENY_BYTES = 20_000;

const ALLOW: PreBashDecision = { kind: "allow" };

// ─── shell words ─────────────────────────────────────────────────────

type Token =
  | { t: "word"; v: string }
  | { t: "op"; v: string }
  | { t: "redir"; v: string; fd: string; target?: string }
  | { t: "sub"; tokens: Token[] };

/** Stands in a word for a `$( )` / backtick / `<( )` substitution: a value we cannot know. */
const SUB = "$(…)";

/** Where the substitution whose body starts at `from` ends: its `)` or closing backtick. */
function closingIndex(src: string, from: number, backtick: boolean): number {
  let depth = 1;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (backtick) {
      if (c === "`") return i;
    } else if (c === "'") {
      i = src.indexOf("'", i + 1);
      if (i === -1) return src.length;
    } else if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === "\\") i++;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }

  return src.length;
}

/**
 * Split a command line into words, operators and redirections the way the
 * shell does, closely enough to tell a command from its arguments. Quotes
 * are removed; comments and heredoc bodies are dropped.
 */
function lex(src: string): Token[] {
  const out: Token[] = [];
  const heredocs: Array<{ delim: string; strip: boolean }> = [];
  let pendingHeredoc: boolean | null = null;
  let word = "";
  let inWord = false;
  let i = 0;

  const flush = (): void => {
    if (!inWord) return;
    out.push({ t: "word", v: word });
    if (pendingHeredoc !== null) {
      heredocs.push({ delim: word, strip: pendingHeredoc });
      pendingHeredoc = null;
    }
    word = "";
    inWord = false;
  };
  const op = (v: string, width: number): void => {
    flush();
    out.push({ t: "op", v });
    i += width;
  };

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "\\") {
      if (next !== "\n") {
        word += next ?? "";
        inWord = true;
      }
      i += 2;
      continue;
    }

    // ANSI-C quoting: backslash escapes, `\'` included.
    if (c === "$" && next === "'") {
      for (i += 2; i < src.length && src[i] !== "'"; i++) word += src[i] === "\\" ? (src[++i] ?? "") : src[i];
      inWord = true;
      i++;
      continue;
    }

    if (c === "'") {
      const from = i + 1;
      const end = src.indexOf("'", from);
      const stop = end === -1 ? src.length : end;
      word += src.slice(from, stop);
      inWord = true;
      i = stop + 1;
      continue;
    }

    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && '"\\$`'.includes(src[i + 1] ?? "")) {
          word += src[i + 1];
          i += 2;
          continue;
        }
        word += src[i++];
      }
      i++;
      inWord = true;
      continue;
    }

    if (c === "#" && !inWord) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }

    if (c === " " || c === "\t" || c === "\r") {
      flush();
      i++;
      continue;
    }

    if (c === "\n") {
      op(";", 1);
      // Heredoc bodies start on the line after their operator.
      for (const doc of heredocs.splice(0)) {
        while (i < src.length) {
          const nl = src.indexOf("\n", i);
          const end = nl === -1 ? src.length : nl;
          const line = src.slice(i, end);
          i = end + 1;
          if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delim) break;
        }
      }
      continue;
    }

    // Command and process substitution: a word of this command whose value
    // we cannot know. The command inside runs on its own, output captured.
    if (((c === "$" || c === "<" || c === ">") && next === "(") || c === "`") {
      const from = c === "`" ? i + 1 : i + 2;
      const close = closingIndex(src, from, c === "`");
      const inner = src.slice(from, close);
      // `$(( … ))` is arithmetic, not a command.
      if (!(c === "$" && inner.startsWith("("))) out.push({ t: "sub", tokens: lex(inner) });
      word += SUB;
      inWord = true;
      i = close + 1;
      continue;
    }

    if (c === ">" || c === "<" || (c === "&" && next === ">")) {
      let fd = "";
      if (inWord && /^\d+$/.test(word)) {
        fd = word;
        word = "";
        inWord = false;
      } else {
        flush();
      }

      let v: string = c;
      i++;
      if (c === "&") {
        v = src[i + 1] === ">" ? "&>>" : "&>";
        i += v.length - 1;
      } else if (c === ">" && (src[i] === ">" || src[i] === "|")) {
        v = c + src[i++];
      } else if (c === "<" && src[i] === "<") {
        i++;
        if (src[i] === "<") v = "<<<";
        else if (src[i] === "-") v = "<<-";
        else v = "<<";
        if (v !== "<<") i++;
        if (v !== "<<<") pendingHeredoc = v === "<<-";
      }

      // Duplication (`2>&1`, `>&2`) names its target inline.
      if ((v === ">" || v === "<") && src[i] === "&") {
        const m = /^[0-9-]*/.exec(src.slice(i + 1))?.[0] ?? "";
        out.push({ t: "redir", v, fd, target: `&${m}` });
        i += 1 + m.length;
        continue;
      }
      out.push({ t: "redir", v, fd });
      continue;
    }

    if (c === "|") {
      // `|&` pipes stderr too: still a pipe.
      op(next === "|" ? "||" : "|", next === "|" || next === "&" ? 2 : 1);
      continue;
    }
    if (c === "&") {
      op(next === "&" ? "&&" : "&", next === "&" ? 2 : 1);
      continue;
    }
    if (c === ";") {
      op(";", next === ";" ? 2 : 1);
      continue;
    }
    if (c === "(" || c === ")") {
      op(c, 1);
      continue;
    }

    word += c;
    inWord = true;
    i++;
  }

  flush();
  return out;
}

interface Segment {
  words: string[];
  redirs: Array<{ v: string; fd: string; target: string }>;
  /** The next command of the pipeline, when stdout goes into a pipe. */
  pipedTo: Segment | null;
  /** Stdin comes from the previous command of a pipeline. */
  pipedFrom: boolean;
  /** Inside `$( )`, `<( )` or backticks: the output is captured, not shown. */
  consumed: boolean;
  /** Filled by strip(). */
  cmd: string;
  args: string[];
  bypass: boolean;
}

function parse(tokens: Token[]): Segment[] {
  const segs: Segment[] = [];
  /** Commands inside substitutions: their output is captured. */
  const captured: Segment[] = [];
  /** Where each open group (`( )`, `{ }`, a loop, an `if`) starts in `segs`. */
  const groups: number[] = [];
  /** What a `|` here would take the output of: the last command, or the whole group it closed. */
  let piping: Segment[] = [];
  let pipeFrom: Segment[] = [];
  let pendingRedir: Segment["redirs"][number] | null = null;

  const fresh = (): Segment => ({
    words: [],
    redirs: [],
    pipedTo: null,
    pipedFrom: false,
    consumed: false,
    cmd: "",
    args: [],
    bypass: false,
  });
  let cur = fresh();

  const closeGroup = (): void => {
    const start = groups.pop();
    if (start !== undefined) piping = segs.slice(start);
  };

  const end = (): void => {
    if (cur.words.length === 0 && cur.redirs.length === 0) return;
    // A command already piped inside the group keeps its own pipe.
    for (const from of pipeFrom) from.pipedTo ??= cur;
    cur.pipedFrom = pipeFrom.length > 0;
    pipeFrom = [];
    segs.push(cur);
    piping = [cur];

    if (CLOSERS.has(cur.words[0])) closeGroup();
    else {
      for (const w of cur.words) {
        if (OPENERS.has(w)) groups.push(segs.length - 1);
        else if (!KEYWORDS.has(w)) break;
      }
    }
    cur = fresh();
  };

  for (const tok of tokens) {
    if (tok.t === "sub") {
      for (const inner of parse(tok.tokens)) {
        inner.consumed = true;
        captured.push(inner);
      }
      continue;
    }

    if (tok.t === "word") {
      if (pendingRedir) {
        pendingRedir.target = tok.v;
        pendingRedir = null;
      } else {
        cur.words.push(tok.v);
      }
      continue;
    }

    if (tok.t === "redir") {
      const r = { v: tok.v, fd: tok.fd, target: tok.target ?? "" };
      cur.redirs.push(r);
      if (tok.target === undefined) pendingRedir = r;
      continue;
    }

    pendingRedir = null;
    end();
    if (tok.v === "|") pipeFrom = piping;
    else if (tok.v === "(") groups.push(segs.length);
    else if (tok.v === ")") closeGroup();
    else {
      pipeFrom = [];
      piping = [];
    }
  }

  end();
  return [...segs, ...captured];
}

/** Words that open and close a group of commands whose joint output a pipe can take. */
const OPENERS = new Set(["{", "if", "for", "while", "until", "select", "case"]);
const CLOSERS = new Set(["}", "fi", "done", "esac"]);

const KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "time", "esac"]);
const PREFIX_COMMANDS = new Set(["sudo", "env", "command", "exec", "nohup", "nice", "time", "timeout", "stdbuf"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const baseName = (word: string): string => word.slice(word.lastIndexOf("/") + 1);

/** Resolve a segment's command word: past keywords, env assignments and wrappers like sudo/env/time. */
function strip(seg: Segment): void {
  const words = [...seg.words];

  while (words.length > 0) {
    const w = words[0];
    if (w === "TOKEN_PILOT_BYPASS=1") seg.bypass = true;
    if (KEYWORDS.has(w) || ASSIGNMENT.test(w)) {
      words.shift();
      continue;
    }

    const name = baseName(w);
    if (!PREFIX_COMMANDS.has(name)) break;
    words.shift();
    while (words.length > 0 && (words[0].startsWith("-") || ASSIGNMENT.test(words[0]) || (/^\d/.test(words[0]) && (name === "nice" || name === "timeout")))) {
      if (words[0] === "TOKEN_PILOT_BYPASS=1") seg.bypass = true;
      words.shift();
    }
  }

  if (words[0] === "export" && words.includes("TOKEN_PILOT_BYPASS=1")) seg.bypass = true;
  seg.cmd = words.length > 0 ? baseName(words[0]) : "";
  seg.args = words.slice(1);
}

// ─── bounded output ──────────────────────────────────────────────────

const SCREEN = new Set(["/dev/stdout", "/dev/stderr", "/dev/tty"]);

function stdoutRedirected(seg: Segment): boolean {
  return seg.redirs.some((r) => {
    const toFile = r.target !== "" && !r.target.startsWith("&") && !SCREEN.has(r.target);
    if (r.v === "&>" || r.v === "&>>") return toFile;

    return (r.v === ">" || r.v === ">>" || r.v === ">|") && (r.fd === "" || r.fd === "1") && toFile;
  });
}

/** Commands that hand every line on: a dump piped through them is still a dump. */
const PASS_THROUGH = new Set(["cat", "tee", "less", "more", "nl", "tac", "sort", "column"]);

/** `code`: what flows in is a code file, so a slice over the limit is the whole file. */
function passesEverything(seg: Segment, code: boolean): boolean {
  if (PASS_THROUGH.has(seg.cmd)) return true;
  if (code && (seg.cmd === "head" || seg.cmd === "tail")) {
    const { lines, bytes } = sliceSize(seg.cmd, seg.args);
    return bytes > 0 ? bytes > SLICE_DENY_BYTES : lines > SLICE_DENY_LINES;
  }
  // `tail -n +1` / `tail +1` starts at a line and prints the rest.
  return seg.cmd === "tail" && seg.args.some((a, i) => /^\+\d/.test(a) || (a === "-n" && /^\+/.test(seg.args[i + 1] ?? "")) || /^-n\+/.test(a));
}

/** Nothing reaches the screen whole: captured, redirected, or piped into a filter. */
function outputBounded(seg: Segment, code = false): boolean {
  if (seg.consumed || stdoutRedirected(seg)) return true;

  for (let next = seg.pipedTo; next; next = next.pipedTo) {
    if (stdoutRedirected(next) || !passesEverything(next, code)) return true;
  }

  return false;
}

// ─── options ─────────────────────────────────────────────────────────

interface Parsed {
  short: Map<string, string | true>;
  long: Map<string, string | true>;
  operands: string[];
}

/**
 * Read a getopt-style argument list. `withValue` names the short options
 * that take a value (`-m 5`, `-m5`, `-rm5`); `longWithValue` the long ones
 * written with a separate value (`--max-count 5`).
 */
function parseOptions(args: string[], withValue: string, longWithValue: ReadonlySet<string> = new Set()): Parsed {
  const short = new Map<string, string | true>();
  const long = new Map<string, string | true>();
  const operands: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }

    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = a.slice(2, eq === -1 ? undefined : eq);
      if (eq !== -1) long.set(name, a.slice(eq + 1));
      else if (longWithValue.has(name)) long.set(name, args[++i] ?? "");
      else long.set(name, true);
      continue;
    }

    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const letter = a[j];
        if (withValue.includes(letter)) {
          short.set(letter, j + 1 < a.length ? a.slice(j + 1) : (args[++i] ?? ""));
          break;
        }
        short.set(letter, true);
      }
      continue;
    }

    operands.push(a);
  }

  return { short, long, operands };
}

/** A path naming one file (it has an extension), not a directory to walk. */
const looksLikeFile = (path: string): boolean =>
  !path.endsWith("/") && /\.[A-Za-z0-9]+$/.test(baseName(path));

// ─── the rules ───────────────────────────────────────────────────────

const bypassHint = "Need the raw output anyway? Prefix the command with `TOKEN_PILOT_BYPASS=1 `.";

function deny(reason: string): PreBashDecision {
  return { kind: "deny", reason: `${reason} ${bypassHint}` };
}

const GREP_LONG_VALUES = new Set(["regexp", "file", "max-count", "after-context", "before-context", "context", "directories", "devices", "include", "exclude", "exclude-dir", "label", "binary-files"]);
const RG_LONG_VALUES = new Set(["regexp", "file", "glob", "iglob", "max-count", "after-context", "before-context", "context", "type", "type-not", "threads", "max-columns", "encoding", "replace", "max-depth", "sort", "sortr", "pre", "pre-glob", "max-filesize", "engine", "colors", "type-add"]);
const SEARCH_BOUNDS = ["max-count", "count", "count-matches", "files-with-matches", "files-without-match", "name-only", "quiet", "silent", "files"];

/**
 * Unbounded recursive search: grep -r and friends, rg, git grep.
 * `readsStdin`: rg with no path searches a piped or redirected stdin, not the
 * tree (grep -r and git grep walk the tree whatever stdin is).
 */
function recursiveSearch(tool: "grep" | "rg" | "git-grep", args: string[], readsStdin = false): boolean {
  const opts =
    tool === "rg"
      ? parseOptions(args, "efgmABCtTjMErd", RG_LONG_VALUES)
      : parseOptions(args, tool === "grep" ? "efmABCdD" : "efmABCO", GREP_LONG_VALUES);

  const recursive =
    tool !== "grep" ||
    opts.short.has("r") ||
    opts.short.has("R") ||
    opts.short.get("d") === "recurse" ||
    opts.long.has("recursive") ||
    opts.long.has("dereference-recursive") ||
    opts.long.get("directories") === "recurse";
  if (!recursive) return false;

  const bounded =
    ["m", "l", "L", "c", "q"].some((f) => opts.short.has(f)) ||
    SEARCH_BOUNDS.some((f) => opts.long.has(f));
  if (bounded) return false;

  const patternGiven = opts.short.has("e") || opts.short.has("f") || opts.long.has("regexp") || opts.long.has("file");
  const paths = patternGiven ? opts.operands : opts.operands.slice(1);
  if (paths.length === 0 && readsStdin) return false;

  // Every path names a single file (or is substituted, so unknown): nothing is walked.
  return !(paths.length > 0 && paths.every((p) => looksLikeFile(p) || p.includes(SUB)));
}

function searchDenied(): PreBashDecision {
  return deny(
    "Unbounded recursive search (`grep -r`, `rg`, `git grep`) dumps every match into your context. " +
      `For an identifier use ${toolPrefix()}find_usages(symbol=...). Otherwise bound it: ` +
      "`-l` (file names only), `-c` (counts), a single file, or `| head -n 50`.",
  );
}

/** Lines (or bytes) `head`/`tail` would print from each file. */
function sliceSize(cmd: string, args: string[]): { lines: number; bytes: number; files: string[] } {
  let lines = 10;
  let bytes = 0;
  const files: string[] = [];

  const count = (v: string): number => {
    if (v.startsWith("+")) return cmd === "tail" ? Infinity : Number.parseInt(v.slice(1), 10);
    if (v.startsWith("-")) return cmd === "head" ? Infinity : Number.parseInt(v.slice(1), 10);
    const m = /^(\d+)\s*([kKmM]?)/.exec(v);
    if (!m) return 10;
    const unit = m[2].toLowerCase() === "k" ? 1024 : m[2].toLowerCase() === "m" ? 1024 * 1024 : 1;

    return Number.parseInt(m[1], 10) * unit;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let m: RegExpExecArray | null;
    if (a === "--") {
      files.push(...args.slice(i + 1));
      break;
    }
    if ((m = /^--lines=(.*)$/.exec(a))) lines = count(m[1]);
    else if (a === "--lines") lines = count(args[++i] ?? "");
    else if ((m = /^--bytes=(.*)$/.exec(a))) bytes = count(m[1]);
    else if (a === "--bytes") bytes = count(args[++i] ?? "");
    else if (a === "-n") lines = count(args[++i] ?? "");
    else if ((m = /^-n(.+)$/.exec(a))) lines = count(m[1]);
    else if (a === "-c") bytes = count(args[++i] ?? "");
    else if ((m = /^-c(.+)$/.exec(a))) bytes = count(m[1]);
    else if ((m = /^-(\d+)$/.exec(a))) lines = Number.parseInt(m[1], 10);
    else if (cmd === "tail" && /^\+\d+$/.test(a)) lines = Infinity;
    else if (cmd === "tail" && a === "-s") i++;
    else if (!a.startsWith("-")) files.push(a);
  }

  return { lines, bytes, files };
}

/** Lines a `sed` script prints from one file, or null when it is not a read we judge. */
function sedLines(args: string[]): { lines: number; files: string[] } | null {
  let quiet = false;
  const scripts: string[] = [];
  const operands: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (a === "--quiet" || a === "--silent") quiet = true;
    else if (a.startsWith("--in-place") || a.startsWith("--file")) return null;
    else if (a === "--expression") scripts.push(args[++i] ?? "");
    else if (a.startsWith("--expression=")) scripts.push(a.slice("--expression=".length));
    else if (a.startsWith("--")) continue;
    else if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const letter = a[j];
        if (letter === "n") quiet = true;
        else if (letter === "i" || letter === "f") return null; // edits in place / script from a file
        else if (letter === "e") {
          scripts.push(j + 1 < a.length ? a.slice(j + 1) : (args[++i] ?? ""));
          break;
        } else if (letter === "l") {
          if (j + 1 === a.length) i++;
          break;
        }
      }
    } else operands.push(a);
  }

  if (scripts.length === 0 && operands.length > 0) scripts.push(operands.shift()!);
  const files = operands.filter(isCodeFile);
  if (scripts.length === 0 || files.length === 0) return null;

  const commands = scripts.join("\n").split(/[;\n]/).map((c) => c.trim()).filter(Boolean);

  if (!quiet) {
    // Without -n sed prints every line, unless it quits early (`20q`).
    const quit = commands.map((c) => /^(\d+)\s*[qQ]$/.exec(c)).find(Boolean);
    return { lines: quit ? Number.parseInt(quit[1], 10) : Infinity, files };
  }

  let lines = 0;
  for (const c of commands) {
    if (c === "p") return { lines: Infinity, files };
    const m = /^(\d+|\$)(?:\s*,\s*(\d+|\$|\+\d+))?\s*p$/.exec(c);
    if (!m) continue; // regex addresses and the like: not ours to judge
    if (!m[2] || m[1] === "$") lines += 1;
    else if (m[2] === "$") return { lines: Infinity, files };
    else if (m[2].startsWith("+")) lines += Number.parseInt(m[2].slice(1), 10) + 1;
    else lines += Math.max(0, Number.parseInt(m[2], 10) - Number.parseInt(m[1], 10) + 1);
  }

  return { lines, files };
}

/** `awk` with a program that prints every line (`1`, `{print}`, `{print $0}`). */
function awkPrintsAll(args: string[]): boolean {
  let program: string | undefined;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-f" || a.startsWith("--file")) return false;
    if (a === "-F" || a === "-v") i++;
    else if (a.startsWith("-")) continue;
    else if (program === undefined) program = a;
    else files.push(a);
  }

  return (
    program !== undefined &&
    files.some(isCodeFile) &&
    /^(1|\/\/|NR>=?[01]|\{print(\$0)?;?\})$/.test(program.replace(/\s+/g, ""))
  );
}

function sliceDenied(what: string, amount: string): PreBashDecision {
  return deny(
    `${what} would print ${amount} of a code file — more than the ${SLICE_DENY_LINES}-line limit. ` +
      `Use ${toolPrefix()}smart_read(path) for its structure, ${toolPrefix()}read_symbol(path, symbol) for one ` +
      `function, or ${toolPrefix()}read_range(path, start_line, end_line) / \`sed -n 'A,Bp'\` for up to ` +
      `${SLICE_DENY_LINES} lines.`,
  );
}

/** `git [global options] <subcommand> …` */
function gitParts(args: string[]): { sub: string; rest: string[] } {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix"].includes(a)) i += 2;
    else if (a.startsWith("-")) i++;
    else break;
  }

  return { sub: args[i] ?? "", rest: args.slice(i + 1) };
}

/** Only words that are clearly revisions; anything else might be a path, and a path bounds the output. */
const REVISION =
  /^(?:HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|@|[0-9a-f]{7,40}|main|master|develop|trunk|staging|production|(?:origin|upstream)\/[\w./-]+)(?:[~^]\d*)*(?:@\{[^}]*\})?$/;
const isRevision = (word: string): boolean => REVISION.test(word) || word.includes("..");

const DIFF_SUMMARY = /^--(?:stat|shortstat|numstat|name-only|name-status|summary|dirstat|compact-summary|raw|check|quiet|no-patch|exit-code)/;

function gitLogBounded(rest: string[]): boolean {
  // A substituted word is unknown: it may well be the count or a range.
  const count = (v: string): boolean => /^\d+$/.test(v) || v.includes(SUB);

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") break;
    if (/^-\d+$/.test(a) || (/^-n./.test(a) && count(a.slice(2))) || (a.startsWith("--max-count=") && count(a.slice(12)))) return true;
    if ((a === "-n" || a === "--max-count") && count(rest[i + 1] ?? "")) return true;
    // A range (`main..HEAD`) bounds the history.
    if (!a.startsWith("-") && (a.includes("..") || a.includes(SUB))) return true;
  }

  return false;
}

/** `git diff` / `git show` limited to a summary or to paths. */
function gitPatchBounded(rest: string[]): boolean {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") return i + 1 < rest.length;
    if (DIFF_SUMMARY.test(a) || a === "-s" || a === "--no-index") return true;
    if (a.startsWith("-")) continue;
    if (!isRevision(a)) return true;
  }

  return false;
}

function gitDecision(args: string[]): PreBashDecision {
  const { sub, rest } = gitParts(args);
  const p = toolPrefix();

  if (sub === "grep") return recursiveSearch("git-grep", rest) ? searchDenied() : ALLOW;

  if (sub === "log" && !gitLogBounded(rest)) {
    return deny(
      `Unbounded \`git log\` can return thousands of commits. Use ${p}smart_log for structured history, ` +
        "or bound it: `-n 20`, a range (`main..HEAD`), or `| head -n 20`.",
    );
  }

  if (sub === "diff" && !gitPatchBounded(rest)) {
    return deny(
      `\`git diff\` over the whole tree can be huge. Use ${p}smart_diff for a per-symbol summary, ` +
        "or scope it: `--stat`, `-- <path>`, or `| head -n 100`.",
    );
  }

  if (sub === "show") {
    const spec = rest.find((a) => !a.startsWith("-") && a.includes(":"));
    if (spec !== undefined) {
      return isCodeFile(spec.slice(spec.indexOf(":") + 1))
        ? sliceDenied("`git show <rev>:<file>`", "the whole file")
        : ALLOW;
    }
    if (!gitPatchBounded(rest)) {
      return deny(
        `\`git show\` prints the commit's whole patch. Use ${p}smart_diff, or scope it: ` +
          "`--stat`, `-- <path>`, or `| head -n 100`.",
      );
    }
  }

  return ALLOW;
}

const FIND_BOUNDS =
  /^-(?:i?name|i?path|i?wholename|i?regex|newer\w*|[amc](?:min|time)|size|empty|user|group|perm|links|inum|samefile|prune|maxdepth|mindepth|quit|delete|exec|execdir|ok|okdir|fprint\w*|fls)$/;

/**
 * `find` over the whole disk or home without a depth limit, elsewhere outside
 * the project with neither a filter nor a depth limit, or the whole repo with
 * no filter at all.
 */
function findDecision(args: string[], projectRoot: string | undefined): PreBashDecision {
  let i = 0;
  while (i < args.length && /^-(?:[HLP]|O\d*|D)$/.test(args[i])) i += args[i] === "-D" ? 2 : 1;

  const roots: string[] = [];
  while (i < args.length && !/^[-(!)]/.test(args[i])) roots.push(args[i++]);
  if (roots.length === 0) roots.push(".");

  const expr = args.slice(i);
  const depthLimited = expr.includes("-maxdepth");
  const filtered = expr.some((a) => FIND_BOUNDS.test(a));
  const root = projectRoot?.replace(/\/+$/, "");

  for (const raw of roots) {
    const r = raw.replace(/\/+$/, "") || "/";
    // The whole disk or the whole home directory: even a filtered walk lists too much.
    const whole = r === "/" || r === "~" || r === "$HOME" || r === "${HOME}";
    const home = /^(?:~|\$HOME|\$\{HOME\})(?:\/|$)/.test(r);
    const outside = home || (r.startsWith("/") && (r === "/" || (root !== undefined && r !== root && !r.startsWith(`${root}/`))));

    if (outside && !depthLimited && (whole || !filtered)) {
      return deny(
        `\`find ${raw}\` walks outside the project and lists every path it meets. ` +
          `Add \`-maxdepth N\`${whole ? "" : " or a filter (`-name <glob>`)"}, start from a directory inside the project, or pipe to \`head\`.`,
      );
    }

    if ((r === "." || r === root) && !filtered) {
      return deny(
        `\`find ${raw}\` with no filter lists every file in the repository (node_modules included). ` +
          `Add \`-name <glob>\` or \`-maxdepth N\`, pipe to \`head\` / \`wc -l\`, or use ${toolPrefix()}project_overview.`,
      );
    }
  }

  return ALLOW;
}

const RUNNERS = new Set(["vitest", "jest", "mocha", "phpunit", "rspec", "pytest"]);

/** The command runs a test suite (not: installs a runner, or mentions one). */
function runsTests(cmd: string, args: string[]): boolean {
  const words = args.filter((a) => !a.startsWith("-"));

  if (RUNNERS.has(cmd)) return true;
  if (cmd === "npx" || cmd === "pnpx" || cmd === "bunx") return RUNNERS.has(baseName(words[0] ?? ""));
  if (cmd === "go" || cmd === "cargo") return words[0] === "test";
  if ((cmd === "python" || cmd === "python3") && args[0] === "-m") return args[1] === "pytest";

  if (cmd === "npm" || cmd === "yarn" || cmd === "pnpm" || cmd === "bun") {
    const [verb, arg, third] = words;
    if (verb === "dlx" || verb === "exec") return RUNNERS.has(arg ?? "");
    if (verb === "run" || verb === "run-script") return /^test(?::|$)/.test(arg ?? "");
    if (verb === "workspace") return third === "test";

    return /^test(?::|$)/.test(verb ?? "");
  }

  return false;
}

// ─── decision ────────────────────────────────────────────────────────

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const VIEWERS = new Set(["cat", "less", "more", "nl", "tac"]);

function judge(seg: Segment, args: string[], opts: PreBashOptions, depth: number): PreBashDecision {
  const { cmd } = seg;

  if (runsTests(cmd, args)) {
    return {
      kind: "advise",
      reason:
        "Running tests via raw command dumps stdout into context. " +
        `Prefer ${toolPrefix()}test_summary(command="<your runner>") — ` +
        "returns structured pass/fail/flaky counts and only the failing output, " +
        "typically 70-90% fewer tokens than raw runner output.",
    };
  }

  if (outputBounded(seg, VIEWERS.has(cmd))) return ALLOW;

  if (SHELLS.has(cmd)) {
    const flag = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    return flag === -1 ? ALLOW : analyse(args[flag + 1] ?? "", opts, depth + 1);
  }
  if (cmd === "eval") return analyse(args.join(" "), opts, depth + 1);

  if (cmd === "grep" || cmd === "egrep" || cmd === "fgrep") {
    return recursiveSearch("grep", args) ? searchDenied() : ALLOW;
  }
  if (cmd === "rg") {
    const readsStdin = seg.pipedFrom || seg.redirs.some((r) => r.v.startsWith("<"));
    return recursiveSearch("rg", args, readsStdin) ? searchDenied() : ALLOW;
  }
  if (cmd === "git") return gitDecision(args);
  if (cmd === "find") return findDecision(args, opts.projectRoot);

  const stdin = seg.redirs.filter((r) => r.v === "<").map((r) => r.target);
  if (VIEWERS.has(cmd) && [...args, ...stdin].some((a) => !a.startsWith("-") && isCodeFile(a))) {
    return deny(
      `\`${cmd}\` on a code file dumps the whole file into context. ` +
        `Use ${toolPrefix()}smart_read(path) for its structure, ${toolPrefix()}read_symbol(path, symbol) ` +
        `for one function, or ${toolPrefix()}read_range(path, start_line, end_line) / \`sed -n 'A,Bp'\` / ` +
        `\`head -n N\` for up to ${SLICE_DENY_LINES} lines.`,
    );
  }

  if (cmd === "head" || cmd === "tail") {
    const { lines, bytes, files } = sliceSize(cmd, args);
    const code = files.filter(isCodeFile).length;
    if (code > 0 && bytes > 0 && bytes * code > SLICE_DENY_BYTES) {
      return sliceDenied(`\`${cmd} -c\``, `${bytes * code} bytes`);
    }
    if (code > 0 && bytes === 0 && lines * code > SLICE_DENY_LINES) {
      return sliceDenied(`\`${cmd}\``, Number.isFinite(lines) ? `${lines * code} lines` : "the whole file");
    }
  }

  if (cmd === "sed") {
    const read = sedLines(args);
    if (read && read.lines * read.files.length > SLICE_DENY_LINES) {
      return sliceDenied("`sed`", Number.isFinite(read.lines) ? `${read.lines * read.files.length} lines` : "the whole file");
    }
  }

  if ((cmd === "awk" || cmd === "gawk" || cmd === "mawk") && awkPrintsAll(args)) {
    return sliceDenied("`awk`", "the whole file");
  }

  return ALLOW;
}

/** `$f` / `${f}` from an enclosing `for f in …` stands for the loop's words. */
function expand(word: string, loopVars: Map<string, string[]>): string[] {
  const m = /^\$\{?([A-Za-z_]\w*)\}?(.*)$/.exec(word);
  const values = m ? loopVars.get(m[1]) : undefined;

  return values ? values.map((v) => v + m![2]) : [word];
}

function analyse(command: string, opts: PreBashOptions, depth: number): PreBashDecision {
  if (depth > 3 || command.trim() === "") return ALLOW;

  const segs = parse(lex(command));
  segs.forEach(strip);
  if (segs.some((s) => s.bypass)) return ALLOW;

  const loopVars = new Map<string, string[]>();
  let advice: PreBashDecision | null = null;

  for (const seg of segs) {
    if (seg.cmd === "for") {
      if (seg.args[1] === "in") loopVars.set(seg.args[0], seg.args.slice(2));
      continue;
    }

    const args = seg.args.flatMap((a) => expand(a, loopVars));
    const decision = judge(seg, args, opts, depth);
    if (decision.kind === "deny") return decision;
    if (decision.kind === "advise") advice ??= decision;
  }

  return advice ?? ALLOW;
}

export function detectHeavyPattern(command: string, opts: PreBashOptions = {}): PreBashDecision {
  try {
    return analyse(command, opts, 0);
  } catch {
    return ALLOW; // a command we cannot read is not one we block
  }
}

export function decidePreBash(
  input: PreBashInput,
  mode: EnforcementMode = "deny",
  opts: PreBashOptions = {},
): PreBashDecision {
  if (mode === "advisory" || opts.bypass) return ALLOW;
  if (input.tool_name !== "Bash") return ALLOW;
  const cmd = input.tool_input?.command;
  if (typeof cmd !== "string") return ALLOW;

  return detectHeavyPattern(cmd, opts);
}

/** Advice carries no permissionDecision: "allow" would skip the user's permission prompt. */
export function renderPreBashOutput(decision: PreBashDecision): string | null {
  if (decision.kind === "allow") return null;
  if (decision.kind === "advise") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: decision.reason,
      },
    });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  });
}
