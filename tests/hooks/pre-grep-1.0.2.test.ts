/**
 * 1.0.2 audit, item 13 — the Grep-tool gate denied searches that are not
 * identifier lookups, and its advice named a `-E` flag the Grep tool lacks.
 * Item 9 — it pointed at code_audit under the npm name on a plugin install.
 */
import { afterEach, describe, expect, it } from "vitest";
import { decidePreGrep } from "../../src/hooks/pre-grep.ts";
import { setPluginInstall } from "../../src/core/tool-names.ts";

const grep = (tool_input: Record<string, unknown>) => decidePreGrep({ tool_name: "Grep", tool_input } as never).kind;

afterEach(() => setPluginInstall(undefined));

describe("Grep gate — what is not an identifier lookup", () => {
  for (const pattern of ["token-pilot", "UTF-8", "x-api-key", "README", "Error", "--max-count"]) {
    it(`allows "${pattern}"`, () => {
      expect(grep({ pattern })).toBe("allow");
    });
  }

  it("allows a search confined to non-code files", () => {
    expect(grep({ pattern: "useState", glob: "*.md" })).toBe("allow");
    expect(grep({ pattern: "useState", type: "md" })).toBe("allow");
    expect(grep({ pattern: "useState", path: "docs/notes.md" })).toBe("allow");
  });

  it("allows bounded output: file names, counts, a head limit", () => {
    expect(grep({ pattern: "useState", output_mode: "files_with_matches" })).toBe("allow");
    expect(grep({ pattern: "useState", output_mode: "count" })).toBe("allow");
    expect(grep({ pattern: "useState", head_limit: 20 })).toBe("allow");
  });

  it("still routes a code identifier to find_usages", () => {
    expect(grep({ pattern: "decidePreBash" })).toBe("deny");
    expect(grep({ pattern: "PreBashDecision", glob: "*.ts" })).toBe("deny");
    expect(grep({ pattern: "get_user_by_id" })).toBe("deny");
  });
});

describe("Grep gate texts", () => {
  it("does not advise a -E flag the Grep tool does not have", () => {
    const d = decidePreGrep({ tool_name: "Grep", tool_input: { pattern: "decidePreBash" } });
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.reason).not.toContain("-E");
  });

  it("names code_audit as this install exposes it", () => {
    setPluginInstall(true);
    const d = decidePreGrep({ tool_name: "Grep", tool_input: { pattern: "TODO|FIXME" } });
    expect(d.kind).toBe("advise");
    if (d.kind === "advise") expect(d.reason).toContain("mcp__plugin_token-pilot_token-pilot__code_audit");
  });
});
