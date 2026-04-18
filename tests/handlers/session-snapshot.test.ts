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
});
