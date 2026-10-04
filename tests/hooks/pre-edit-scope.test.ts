/**
 * 1.0.2 audit — the Edit gate:
 *  - item 7: the strict deny told the agent to "set TOKEN_PILOT_BYPASS=1 in
 *    the environment", which an agent cannot do for the hook process;
 *  - item 9: it named the npm tool even on a plugin install;
 *  - item 11: a file outside the project deadlocked strict mode — the gate
 *    demanded read_for_edit, and read_for_edit refuses paths outside the
 *    project.
 */
import { afterEach, describe, expect, it } from "vitest";
import { decidePreEdit, type PreEditContext } from "../../src/hooks/pre-edit.ts";
import { setPluginInstall } from "../../src/core/tool-names.ts";

const ctx = (o: Partial<PreEditContext> = {}): PreEditContext => ({
  mode: "strict",
  isCodeFile: true,
  fileExists: true,
  isPrepared: false,
  bypassed: false,
  ...o,
});

const edit = { tool_name: "Edit", tool_input: { file_path: "/p/src/app.ts" } };

afterEach(() => setPluginInstall(undefined));

describe("Edit gate", () => {
  it("does not tell the agent to set an environment variable", () => {
    const d = decidePreEdit(edit, ctx());
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") {
      expect(d.reason).not.toMatch(/set TOKEN_PILOT_BYPASS=1 in the environment/);
      expect(d.reason).toContain("ask the user");
    }
  });

  it("names read_for_edit as this install exposes it", () => {
    setPluginInstall(true);
    const d = decidePreEdit(edit, ctx({ mode: "deny" }));
    expect(d.kind).toBe("advise");
    if (d.kind === "advise") {
      expect(d.message).toContain("mcp__plugin_token-pilot_token-pilot__read_for_edit");
    }
  });

  it("leaves a file outside the project alone, even in strict mode", () => {
    expect(decidePreEdit(edit, ctx({ outsideProject: true })).kind).toBe("allow");
  });
});
