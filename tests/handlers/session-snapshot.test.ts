/**
 * Regression tests for handleSessionSnapshot — guards against dropped
 * fields between the tool schema and the rendered markdown body. The
 * original bug (harsh-review catch): server.ts dispatch type elided
 * `decisions`, so schema-accepted values never reached the renderer.
 */
import { describe, it, expect } from "vitest";
import { handleSessionSnapshot } from "../../src/handlers/session-snapshot.ts";

describe("handleSessionSnapshot", () => {
  it("renders every schema field when provided", () => {
    const out = handleSessionSnapshot({
      goal: "ship v0.22.1",
      decisions: ["kept adaptive threshold default-off", "dropped TP-7i3"],
      confirmed: ["879 tests green"],
      files: ["src/core/session-registry.ts"],
      blocked: "waiting for review",
      next: "merge + publish",
    });
    const text = out.content[0].text;
    expect(text).toContain("**Goal:** ship v0.22.1");
    expect(text).toContain("**Decisions:**");
    expect(text).toContain("kept adaptive threshold default-off");
    expect(text).toContain("dropped TP-7i3");
    expect(text).toContain("**Confirmed:**");
    expect(text).toContain("879 tests green");
    expect(text).toContain("**Files:** src/core/session-registry.ts");
    expect(text).toContain("**Blocked:** waiting for review");
    expect(text).toContain("**Next:** merge + publish");
  });

  it("omits sections that were not provided", () => {
    const out = handleSessionSnapshot({ goal: "minimal" });
    const text = out.content[0].text;
    expect(text).toContain("**Goal:** minimal");
    expect(text).not.toContain("**Decisions:**");
    expect(text).not.toContain("**Confirmed:**");
    expect(text).not.toContain("**Files:**");
    expect(text).not.toContain("**Blocked:**");
    expect(text).not.toContain("**Next:**");
  });

  it("a string where a list is expected is one item, not one bullet per character", () => {
    const text = handleSessionSnapshot({ goal: "g", decisions: "use -z" as never }).content[0].text;
    expect(text).toContain("- use -z");
    expect(text).not.toContain("- u\n");
  });

  it("rejects input of the wrong type instead of rendering it", () => {
    expect(() => handleSessionSnapshot({ goal: "g", decisions: [1, 2] as never })).toThrow(/decisions/);
    expect(() => handleSessionSnapshot({ goal: 42 as never })).toThrow(/goal/);
    expect(() => handleSessionSnapshot({ goal: "g", next: { a: 1 } as never })).toThrow(/next/);
    expect(() => handleSessionSnapshot({ goal: "g", files: "a.ts" as never })).not.toThrow();
  });
});

describe("session_snapshot tool definition", () => {
  it("says where it writes and how to opt out", async () => {
    const { TOOL_DEFINITIONS } = await import("../../src/server/tool-definitions.ts");
    const def = TOOL_DEFINITIONS.find((t: { name: string }) => t.name === "session_snapshot")!;
    expect(def.description).toContain(".token-pilot/snapshots/");
    expect(def.description).toContain("latest.md");
    expect(def.inputSchema.properties).toHaveProperty("persist");
  });
});
