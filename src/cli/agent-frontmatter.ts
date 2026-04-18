/**
 * Agent-frontmatter helpers (subtask 3.1).
 *
 * Parses and writes YAML-style frontmatter in Claude Code agent .md files.
 * Handles the three tools-field forms:
 *   - wildcard   : "*" | "All tools"
 *   - exclusion  : "All tools [except X, Y]"
 *   - explicit   : "Read, Edit, Bash" | string[] (YAML list)
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToolsWildcard = { kind: "wildcard" };
export type ToolsExclusion = { kind: "exclusion"; excluded: string[] };
export type ToolsExplicit = { kind: "explicit"; tools: string[] };
export type ParsedTools = ToolsWildcard | ToolsExclusion | ToolsExplicit;

export interface FrontmatterResult {
  /** Parsed YAML fields. Values may be strings, arrays, or nested objects. */
  meta: Record<string, any>;
  /** Everything after the closing --- delimiter (may be empty string). */
  body: string;
}

// ─── parseFrontmatter ─────────────────────────────────────────────────────────

/**
 * Parse YAML-style frontmatter from an agent markdown file.
 *
 * Handles:
 *  - Simple key: value pairs
 *  - YAML list items (- value)
 *  - Nested blocks (token_pilot: / sub-key: value)
 *  - CRLF line endings
 */
export function parseFrontmatter(md: string): FrontmatterResult {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: md };
  }

  const yamlText = match[1];
  const body = match[2] ?? "";
  const meta = parseSimpleYaml(yamlText);
  return { meta, body };
}

/**
 * Parse a subset of YAML sufficient for agent frontmatter.
 * Supports: scalar values, inline lists, block lists, nested maps.
 */
function parseSimpleYaml(text: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (!line.trim()) {
      i++;
      continue;
    }

    // Top-level key: value
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }

    const key = kv[1];
    const rawVal = kv[2].trim();

    // Empty value → could be a nested block or inline list
    if (rawVal === "") {
      // Look ahead for indented lines (nested block or list)
      const nested: string[] = [];
      i++;
      while (
        i < lines.length &&
        (lines[i].startsWith("  ") || lines[i].startsWith("\t"))
      ) {
        nested.push(lines[i]);
        i++;
      }

      if (nested.length === 0) {
        result[key] = "";
        continue;
      }

      // Check if it's a list (items start with "  - ")
      if (nested[0].trim().startsWith("- ")) {
        result[key] = nested.map((l) => l.trim().replace(/^-\s+/, ""));
      } else {
        // Nested map — dedent and recurse
        const dedented = nested.map((l) => l.replace(/^  /, "")).join("\n");
        result[key] = parseSimpleYaml(dedented);
      }
      continue;
    }

    // Inline YAML list: [a, b, c]
    if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      result[key] = rawVal
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i++;
      continue;
    }

    // Boolean values
    if (rawVal === "true") {
      result[key] = true;
      i++;
      continue;
    }
    if (rawVal === "false") {
      result[key] = false;
      i++;
      continue;
    }

    // Strip surrounding quotes
    if (
      (rawVal.startsWith("'") && rawVal.endsWith("'")) ||
      (rawVal.startsWith('"') && rawVal.endsWith('"'))
    ) {
      result[key] = rawVal.slice(1, -1);
      i++;
      continue;
    }

    result[key] = rawVal;
    i++;
  }

  return result;
}

// ─── writeFrontmatter ─────────────────────────────────────────────────────────

/**
 * Serialize meta + body back to a markdown string with YAML frontmatter.
 */
export function writeFrontmatter({ meta, body }: FrontmatterResult): string {
  const yaml = serializeYaml(meta);
  return `---\n${yaml}---\n${body}`;
}

function serializeYaml(obj: Record<string, any>, indent = ""): string {
  let out = "";
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) continue;

    if (Array.isArray(val)) {
      out += `${indent}${key}:\n`;
      for (const item of val) {
        out += `${indent}  - ${item}\n`;
      }
    } else if (typeof val === "object") {
      out += `${indent}${key}:\n`;
      out += serializeYaml(val as Record<string, any>, indent + "  ");
    } else if (typeof val === "boolean") {
      out += `${indent}${key}: ${val}\n`;
    } else {
      // Quote strings containing special YAML chars
      const s = String(val);
      const needsQuote = /[:#\[\]{}&*!,|>'"%@`]/.test(s) || s.trim() !== s;
      out += `${indent}${key}: ${needsQuote ? `"${s.replace(/"/g, '\\"')}"` : s}\n`;
    }
  }
  return out;
}

// ─── parseToolsField ─────────────────────────────────────────────────────────

/**
 * Parse the tools field from an agent frontmatter into one of three forms.
 *
 * @param raw - Raw value from parsed frontmatter (string, string[], or undefined)
 */
export function parseToolsField(
  raw: string | string[] | undefined,
): ParsedTools {
  // Array form — already a YAML list
  if (Array.isArray(raw)) {
    return {
      kind: "explicit",
      tools: raw.map((s) => s.trim()).filter(Boolean),
    };
  }

  if (!raw) {
    return { kind: "explicit", tools: [] };
  }

  const s = raw.trim();

  // Strip surrounding quotes
  const unquoted =
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
      ? s.slice(1, -1).trim()
      : s;

  // Wildcard forms
  if (unquoted === "*" || unquoted === "All tools") {
    return { kind: "wildcard" };
  }

  // Exclusion form: "All tools [except X, Y]" or "All tools except X, Y"
  const exclusionMatch = unquoted.match(
    /^All tools\s+(?:\[except\s+|except\s+)(.*?)\]?$/i,
  );
  if (exclusionMatch) {
    const excluded = exclusionMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { kind: "exclusion", excluded };
  }

  // Explicit comma-separated list
  const tools = unquoted
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { kind: "explicit", tools };
}
