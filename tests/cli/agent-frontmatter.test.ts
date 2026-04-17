import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  writeFrontmatter,
  parseToolsField,
} from "../../src/cli/agent-frontmatter.js";

// ─── parseFrontmatter ─────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  it("parses simple key-value frontmatter", () => {
    const md = `---
name: my-agent
description: Does things
---
# Body content
`;
    const result = parseFrontmatter(md);
    expect(result.meta.name).toBe("my-agent");
    expect(result.meta.description).toBe("Does things");
    expect(result.body).toBe("# Body content\n");
  });

  it("returns empty meta + full content as body if no frontmatter", () => {
    const md = "# Just a body\nNo frontmatter here.\n";
    const result = parseFrontmatter(md);
    expect(result.meta).toEqual({});
    expect(result.body).toBe("# Just a body\nNo frontmatter here.\n");
  });

  it("handles empty body after frontmatter", () => {
    const md = "---\nname: agent\n---\n";
    const result = parseFrontmatter(md);
    expect(result.meta.name).toBe("agent");
    expect(result.body).toBe("");
  });

  it("parses tools as single star string", () => {
    const md = "---\nname: a\ntools: '*'\n---\nbody\n";
    const result = parseFrontmatter(md);
    expect(result.meta.tools).toBe("*");
    expect(result.body).toBe("body\n");
  });

  it("parses tools unquoted star", () => {
    const md = "---\nname: a\ntools: *\n---\nbody\n";
    const result = parseFrontmatter(md);
    expect(result.meta.tools).toBe("*");
  });

  it("parses All-tools-except exclusion form", () => {
    const md =
      "---\nname: a\ntools: All tools [except mcp__bad, mcp__other]\n---\nbody\n";
    const result = parseFrontmatter(md);
    expect(result.meta.tools).toBe("All tools [except mcp__bad, mcp__other]");
  });

  it("parses nested YAML map (token_pilot block)", () => {
    const md = `---
name: my-agent
token_pilot:
  blessed: true
  upstream: /some/path
  blessed_at: 2026-01-01T00:00:00.000Z
---
body
`;
    const result = parseFrontmatter(md);
    expect(result.meta.name).toBe("my-agent");
    expect(result.meta.token_pilot).toMatchObject({
      blessed: true,
      upstream: "/some/path",
    });
  });

  it("handles frontmatter with CRLF line endings", () => {
    const md = "---\r\nname: agent\r\ntools: *\r\n---\r\nbody\r\n";
    const result = parseFrontmatter(md);
    expect(result.meta.name).toBe("agent");
    expect(result.meta.tools).toBe("*");
    expect(result.body).toBe("body\r\n");
  });
});

// ─── writeFrontmatter ─────────────────────────────────────────────────────────

describe("writeFrontmatter", () => {
  it("roundtrips simple string fields", () => {
    const input = {
      meta: { name: "my-agent", description: "Does things" },
      body: "# Body\n",
    };
    const out = writeFrontmatter(input);
    const re = parseFrontmatter(out);
    expect(re.meta.name).toBe("my-agent");
    expect(re.meta.description).toBe("Does things");
    expect(re.body).toBe("# Body\n");
  });

  it("serialises tools list as YAML list", () => {
    const tools = [
      "mcp__token-pilot__smart_read",
      "mcp__token-pilot__read_symbol",
    ];
    const out = writeFrontmatter({
      meta: { name: "agent", tools },
      body: "",
    });
    // Must contain the tool names in the frontmatter
    expect(out).toContain("mcp__token-pilot__smart_read");
    expect(out).toContain("mcp__token-pilot__read_symbol");
    const re = parseFrontmatter(out);
    expect(Array.isArray(re.meta.tools)).toBe(true);
    expect(re.meta.tools).toContain("mcp__token-pilot__smart_read");
  });

  it("serialises nested token_pilot block", () => {
    const out = writeFrontmatter({
      meta: {
        name: "agent",
        token_pilot: {
          blessed: true,
          upstream: "/path",
          blessed_at: "2026-01-01T00:00:00.000Z",
          token_pilot_version: "0.20.0",
          upstream_hash: "abc123",
        },
      },
      body: "body\n",
    });
    expect(out).toContain("token_pilot:");
    expect(out).toContain("blessed: true");
    expect(out).toContain("upstream: /path");
    const re = parseFrontmatter(out);
    expect(re.meta.token_pilot).toMatchObject({ blessed: true });
  });

  it("produces valid ---…--- delimiters", () => {
    const out = writeFrontmatter({ meta: { name: "x" }, body: "" });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("\n---\n");
  });
});

// ─── parseToolsField ──────────────────────────────────────────────────────────

describe("parseToolsField", () => {
  it("recognises * as wildcard", () => {
    expect(parseToolsField("*")).toEqual({ kind: "wildcard" });
  });

  it("recognises quoted star as wildcard", () => {
    // After YAML parse, quotes would already be stripped, but let's be safe
    expect(parseToolsField("'*'")).toEqual({ kind: "wildcard" });
  });

  it("recognises All tools as wildcard", () => {
    expect(parseToolsField("All tools")).toEqual({ kind: "wildcard" });
  });

  it("recognises All tools except form — no MCP excluded", () => {
    const result = parseToolsField("All tools [except mcp__bad, Bash]");
    expect(result.kind).toBe("exclusion");
    if (result.kind === "exclusion") {
      expect(result.excluded).toContain("mcp__bad");
      expect(result.excluded).toContain("Bash");
    }
  });

  it("recognises All tools except form — with mcp__token-pilot__ excluded", () => {
    const result = parseToolsField(
      "All tools [except mcp__token-pilot__smart_read]",
    );
    expect(result.kind).toBe("exclusion");
    if (result.kind === "exclusion") {
      expect(result.excluded).toContain("mcp__token-pilot__smart_read");
    }
  });

  it("parses comma-separated explicit list", () => {
    const result = parseToolsField("Read, Edit, Bash");
    expect(result.kind).toBe("explicit");
    if (result.kind === "explicit") {
      expect(result.tools).toContain("Read");
      expect(result.tools).toContain("Edit");
      expect(result.tools).toContain("Bash");
    }
  });

  it("parses YAML array (already parsed to string array)", () => {
    // When parsed from frontmatter, tools may arrive as an array already
    const result = parseToolsField([
      "Read",
      "Edit",
      "mcp__token-pilot__smart_read",
    ]);
    expect(result.kind).toBe("explicit");
    if (result.kind === "explicit") {
      expect(result.tools).toContain("Read");
      expect(result.tools).toContain("mcp__token-pilot__smart_read");
    }
  });

  it("returns explicit for undefined/empty", () => {
    const result = parseToolsField(undefined);
    expect(result.kind).toBe("explicit");
    if (result.kind === "explicit") {
      expect(result.tools).toEqual([]);
    }
  });
});
