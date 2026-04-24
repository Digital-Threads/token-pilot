/**
 * Tests for pre-edit hook decision logic.
 *
 * The function is pure (context is fully resolved by the caller) so we
 * test the decision matrix directly: every scope rule from the module
 * doc × every enforcement mode × new-file edge cases.
 */
import { describe, expect, it } from "vitest";
import {
  decidePreEdit,
  renderPreEditOutput,
  type PreEditContext,
  type PreEditInput,
} from "../../src/hooks/pre-edit.ts";

function ctx(overrides: Partial<PreEditContext> = {}): PreEditContext {
  return {
    mode: "deny",
    isCodeFile: true,
    fileExists: true,
    isPrepared: false,
    bypassed: false,
    ...overrides,
  };
}

function editInput(filePath: string, tool = "Edit"): PreEditInput {
  return { tool_name: tool, tool_input: { file_path: filePath } };
}

describe("decidePreEdit", () => {
  // ── Positive: tools we actually enforce ─────────────────────────────

  it("denies Edit on an existing code file when not prepared (default mode)", () => {
    const decision = decidePreEdit(editInput("/p/src/app.ts"), ctx());
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toContain("read_for_edit");
      expect(decision.reason).toContain("/p/src/app.ts");
      expect(decision.reason).toContain("TOKEN_PILOT_BYPASS");
    }
  });

  it("denies MultiEdit on an existing code file when not prepared", () => {
    const decision = decidePreEdit(
      editInput("/p/src/app.ts", "MultiEdit"),
      ctx(),
    );
    expect(decision.kind).toBe("deny");
  });

  it("denies Write on an existing code file when not prepared (overwrite)", () => {
    const decision = decidePreEdit(editInput("/p/src/app.ts", "Write"), ctx());
    expect(decision.kind).toBe("deny");
  });

  it("allows Edit on a non-existent file (let Claude Code report the real error)", () => {
    const decision = decidePreEdit(
      editInput("/p/src/missing.ts"),
      ctx({ fileExists: false }),
    );
    expect(decision.kind).toBe("allow");
  });

  // ── Allow cases ────────────────────────────────────────────────────

  it("allows Edit when the file is already prepared", () => {
    expect(
      decidePreEdit(editInput("/p/src/app.ts"), ctx({ isPrepared: true })).kind,
    ).toBe("allow");
  });

  it("allows Write on a non-existent file (new-file creation)", () => {
    const decision = decidePreEdit(
      editInput("/p/src/new.ts", "Write"),
      ctx({ fileExists: false }),
    );
    expect(decision.kind).toBe("allow");
  });

  it("allows TOKEN_PILOT_BYPASS=1 even without prep", () => {
    const decision = decidePreEdit(
      editInput("/p/src/app.ts"),
      ctx({ bypassed: true }),
    );
    expect(decision.kind).toBe("allow");
  });

  it("allows non-code files (markdown, json, yaml, config)", () => {
    const decision = decidePreEdit(
      editInput("/p/README.md"),
      ctx({ isCodeFile: false }),
    );
    expect(decision.kind).toBe("allow");
  });

  it("allows unrelated tool calls (not Edit/MultiEdit/Write)", () => {
    const decision = decidePreEdit(
      { tool_name: "Bash", tool_input: { file_path: "/p/src/app.ts" } },
      ctx(),
    );
    expect(decision.kind).toBe("allow");
  });

  it("allows when file_path is missing or empty", () => {
    expect(
      decidePreEdit({ tool_name: "Edit", tool_input: {} }, ctx()).kind,
    ).toBe("allow");
    expect(
      decidePreEdit({ tool_name: "Edit", tool_input: { file_path: "" } }, ctx())
        .kind,
    ).toBe("allow");
  });

  // ── Advisory mode ──────────────────────────────────────────────────

  it("advisory mode: allow + hint when not prepared", () => {
    const decision = decidePreEdit(
      editInput("/p/src/app.ts"),
      ctx({ mode: "advisory" }),
    );
    expect(decision.kind).toBe("advise");
    if (decision.kind === "advise") {
      expect(decision.message).toContain("read_for_edit");
      expect(decision.message).toContain("Consider");
    }
  });

  it("advisory mode: clean allow when already prepared (no noise)", () => {
    const decision = decidePreEdit(
      editInput("/p/src/app.ts"),
      ctx({ mode: "advisory", isPrepared: true }),
    );
    expect(decision.kind).toBe("allow");
  });

  // ── Strict mode treated identically to deny at the decision layer ───

  it("strict mode denies exactly like deny mode", () => {
    const denyDec = decidePreEdit(editInput("/p/x.ts"), ctx({ mode: "deny" }));
    const strictDec = decidePreEdit(
      editInput("/p/x.ts"),
      ctx({ mode: "strict" }),
    );
    expect(denyDec.kind).toBe("deny");
    expect(strictDec.kind).toBe("deny");
  });
});

describe("renderPreEditOutput", () => {
  it("returns null for allow (no-op for the hook)", () => {
    expect(renderPreEditOutput({ kind: "allow" })).toBeNull();
  });

  it("renders deny with permissionDecision=deny", () => {
    const out = renderPreEditOutput({ kind: "deny", reason: "nope" });
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe("nope");
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });

  it("renders advise with permissionDecision=allow + additionalContext", () => {
    const out = renderPreEditOutput({ kind: "advise", message: "hint" });
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(parsed.hookSpecificOutput.additionalContext).toBe("hint");
  });
});
