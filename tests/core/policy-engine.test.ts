import { describe, it, expect } from "vitest";
import {
  checkPolicy,
  isFullReadTool,
  DEFAULT_POLICIES,
} from "../../src/core/policy-engine.js";

describe("checkPolicy", () => {
  it("warns when maxFullFileReads exceeded", () => {
    const result = checkPolicy(DEFAULT_POLICIES, "smart_read", {
      fullFileReadsCount: 10,
      tokensReturned: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.level).toBe("warn");
    expect(result!.message).toContain("POLICY");
    expect(result!.message).toContain("full-file reads");
  });

  it("does not warn when under maxFullFileReads", () => {
    const result = checkPolicy(DEFAULT_POLICIES, "smart_read", {
      fullFileReadsCount: 5,
      tokensReturned: 100,
    });

    // Should not trigger maxFullFileReads, but may trigger other policies
    if (result) {
      expect(result.message).not.toContain("full-file reads");
    }
  });

  it("warns on large reads", () => {
    const result = checkPolicy(DEFAULT_POLICIES, "read_range", {
      fullFileReadsCount: 0,
      tokensReturned: 3000,
    });

    expect(result).not.toBeNull();
    expect(result!.level).toBe("info");
    expect(result!.message).toContain("Large response");
  });

  it("does not warn on small reads", () => {
    const result = checkPolicy(DEFAULT_POLICIES, "read_range", {
      fullFileReadsCount: 0,
      tokensReturned: 100,
    });

    expect(result).toBeNull();
  });

  it("suggests cheap reads for expensive tools with high token count", () => {
    const result = checkPolicy(DEFAULT_POLICIES, "smart_read", {
      fullFileReadsCount: 0,
      tokensReturned: 800,
    });

    expect(result).not.toBeNull();
    expect(result!.message).toContain("POLICY");
  });

  it("returns null for edit tool (requireReadForEditBeforeEdit removed in v0.30.0)", () => {
    // The requireReadForEditBeforeEdit advisory was removed: editTargetPath
    // was never set by the caller, so the check was permanently dead code.
    const result = checkPolicy(DEFAULT_POLICIES, "edit", {
      fullFileReadsCount: 0,
      tokensReturned: 0,
    });

    expect(result).toBeNull();
  });

  it("returns null for unknown tools with no policy triggers", () => {
    const result = checkPolicy(DEFAULT_POLICIES, "session_analytics", {
      fullFileReadsCount: 0,
      tokensReturned: 50,
    });

    expect(result).toBeNull();
  });

  it("respects disabled policies", () => {
    const disabledPolicies = {
      ...DEFAULT_POLICIES,
      preferCheapReads: false,
      warnOnLargeReads: false,
      maxFullFileReads: 0,
    };

    const result = checkPolicy(disabledPolicies, "smart_read", {
      fullFileReadsCount: 100,
      tokensReturned: 5000,
    });

    expect(result).toBeNull();
  });
});

describe("isFullReadTool", () => {
  it("identifies smart_read as full read tool", () => {
    expect(isFullReadTool("smart_read")).toBe(true);
  });

  it("identifies smart_read_many as full read tool", () => {
    expect(isFullReadTool("smart_read_many")).toBe(true);
  });

  it("does not identify read_symbol as full read tool", () => {
    expect(isFullReadTool("read_symbol")).toBe(false);
  });

  it("does not identify read_range as full read tool", () => {
    expect(isFullReadTool("read_range")).toBe(false);
  });
});
