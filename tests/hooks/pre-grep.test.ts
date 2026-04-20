/**
 * v0.28.0 — PreToolUse:Grep advisor tests.
 *
 * Covers isSymbolLikePattern's decision matrix and decidePreGrep's
 * integration (including non-Grep tools, missing pattern, regex-bypass).
 */
import { describe, it, expect } from "vitest";
import {
  isSymbolLikePattern,
  decidePreGrep,
  renderPreGrepOutput,
} from "../../src/hooks/pre-grep.ts";

describe("isSymbolLikePattern", () => {
  it("camelCase is symbol-like", () => {
    expect(isSymbolLikePattern("fooBar")).toBe(true);
    expect(isSymbolLikePattern("getUserById")).toBe(true);
  });

  it("PascalCase is symbol-like", () => {
    expect(isSymbolLikePattern("UserService")).toBe(true);
    expect(isSymbolLikePattern("Foo")).toBe(false); // too short (<4)
    expect(isSymbolLikePattern("Foos")).toBe(true);
  });

  it("snake_case is symbol-like", () => {
    expect(isSymbolLikePattern("get_user_by_id")).toBe(true);
    expect(isSymbolLikePattern("user_id")).toBe(true);
  });

  it("CONSTANT_CASE is symbol-like", () => {
    expect(isSymbolLikePattern("MAX_RETRIES")).toBe(true);
    expect(isSymbolLikePattern("API_KEY")).toBe(true);
  });

  it("kebab-case is symbol-like", () => {
    expect(isSymbolLikePattern("user-profile")).toBe(true);
  });

  it("short generic terms are NOT symbol-like", () => {
    expect(isSymbolLikePattern("id")).toBe(false);
    expect(isSymbolLikePattern("err")).toBe(false);
    expect(isSymbolLikePattern("db")).toBe(false);
  });

  it("regex-shaped patterns are NOT symbol-like", () => {
    expect(isSymbolLikePattern("fn.*\\(")).toBe(false);
    expect(isSymbolLikePattern("foo|bar")).toBe(false);
    expect(isSymbolLikePattern("foo(bar)")).toBe(false);
    expect(isSymbolLikePattern("^function")).toBe(false);
    expect(isSymbolLikePattern("foo\\b")).toBe(false);
    expect(isSymbolLikePattern("foo?")).toBe(false);
    expect(isSymbolLikePattern("[A-Z]+")).toBe(false);
  });

  it("pure lowercase dictionary words are NOT symbol-like", () => {
    // No upper-in-middle, no _, no -, no leading capital: looks like prose
    expect(isSymbolLikePattern("function")).toBe(false);
    expect(isSymbolLikePattern("userlist")).toBe(false);
  });

  it("patterns with spaces are NOT symbol-like", () => {
    expect(isSymbolLikePattern("foo bar")).toBe(false);
  });

  it("purely numeric patterns are NOT symbol-like", () => {
    expect(isSymbolLikePattern("12345")).toBe(false);
  });
});

describe("decidePreGrep", () => {
  it("non-Grep tool → allow", () => {
    expect(decidePreGrep({ tool_name: "Read" }).kind).toBe("allow");
    expect(decidePreGrep({ tool_name: "Bash" }).kind).toBe("allow");
  });

  it("missing pattern → allow", () => {
    expect(decidePreGrep({ tool_name: "Grep", tool_input: {} }).kind).toBe(
      "allow",
    );
  });

  it("symbol-like pattern → deny with suggestion", () => {
    const d = decidePreGrep({
      tool_name: "Grep",
      tool_input: { pattern: "getUserById" },
    });
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") {
      expect(d.reason).toMatch(/find_usages/);
      expect(d.reason).toMatch(/getUserById/);
    }
  });

  it("regex pattern → allow (user intends raw search)", () => {
    expect(
      decidePreGrep({
        tool_name: "Grep",
        tool_input: { pattern: "fn\\s+\\w+" },
      }).kind,
    ).toBe("allow");
  });

  it("short generic term → allow (Grep wins on `id`, `err`)", () => {
    expect(
      decidePreGrep({ tool_name: "Grep", tool_input: { pattern: "id" } }).kind,
    ).toBe("allow");
  });

  it("advisory mode: symbol-like pattern → allow (no blocking)", () => {
    // In advisory mode every Grep is let through regardless of pattern shape.
    const d = decidePreGrep(
      { tool_name: "Grep", tool_input: { pattern: "getUserById" } },
      "advisory",
    );
    expect(d.kind).toBe("allow");
  });

  it("deny mode (default): symbol-like pattern → deny", () => {
    const d = decidePreGrep(
      { tool_name: "Grep", tool_input: { pattern: "UserService" } },
      "deny",
    );
    expect(d.kind).toBe("deny");
  });

  it("strict mode: symbol-like pattern → deny (same as deny)", () => {
    const d = decidePreGrep(
      { tool_name: "Grep", tool_input: { pattern: "UserService" } },
      "strict",
    );
    expect(d.kind).toBe("deny");
  });
});

describe("renderPreGrepOutput", () => {
  it("allow decision → null (silent pass-through)", () => {
    expect(renderPreGrepOutput({ kind: "allow" })).toBeNull();
  });

  it("deny decision → valid JSON with permissionDecision: deny", () => {
    const json = renderPreGrepOutput({ kind: "deny", reason: "use X" })!;
    const parsed = JSON.parse(json);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe("use X");
  });
});
