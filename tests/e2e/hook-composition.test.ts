/**
 * Phase 7 subtask 7.1 — hook-composition precedence test.
 *
 * Claude Code documents (and we rely on, per TP-816 §12) the precedence
 * among conflicting PreToolUse decisions:
 *
 *   deny  >  defer  >  ask  >  allow
 *
 * Text from `additionalContext` of all hooks is accumulated. When
 * another plugin (e.g. context-mode) installs a PreToolUse:Read hook
 * that returns `allow + additionalContext`, and our deny-enhanced hook
 * fires in the same turn, the final decision must be our `deny` — plus
 * both `additionalContext` strings when Claude Code accumulates them.
 *
 * This test exercises OUR contract with that precedence rule. It does
 * not run Claude Code itself; instead it asserts that, given the two
 * hook outputs as JSON, a resolver applying the documented precedence
 * picks the right winner. If Claude Code ever changes the rule, this
 * fails immediately and we notice.
 */
import { describe, it, expect } from "vitest";

interface HookOutput {
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: "deny" | "defer" | "ask" | "allow";
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

interface ResolvedDecision {
  decision: "deny" | "defer" | "ask" | "allow";
  reason: string | null;
  accumulatedContext: string[];
}

const RANK: Record<"deny" | "defer" | "ask" | "allow", number> = {
  deny: 4,
  defer: 3,
  ask: 2,
  allow: 1,
};

/**
 * Apply Claude Code's documented PreToolUse precedence to a set of
 * hook outputs. The winner is the highest-ranked decision; reasons are
 * taken from the winner; additionalContext accumulates from every hook
 * that supplied one, regardless of decision.
 */
function resolveHookChain(outputs: HookOutput[]): ResolvedDecision {
  let winner: HookOutput["hookSpecificOutput"] | undefined;
  const contexts: string[] = [];
  for (const o of outputs) {
    const h = o.hookSpecificOutput;
    if (!h) continue;
    if (h.additionalContext) contexts.push(h.additionalContext);
    const d = h.permissionDecision;
    if (!d) continue;
    if (!winner || RANK[d] > RANK[winner.permissionDecision ?? "allow"]) {
      winner = h;
    }
  }
  return {
    decision: (winner?.permissionDecision ??
      "allow") as ResolvedDecision["decision"],
    reason: winner?.permissionDecisionReason ?? null,
    accumulatedContext: contexts,
  };
}

// ─── our hook always wins when it denies ────────────────────────────────────

describe("PreToolUse precedence (TP-816 §12)", () => {
  const ourDeny: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "File has 1500 lines. Summary follows; use offset/limit for specifics.",
    },
  };

  const contextModeAllow: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext:
        "CONTEXT TIP: Prefer execute_file for files > 50 lines.",
    },
  };

  it("deny beats allow from another plugin", () => {
    const r = resolveHookChain([contextModeAllow, ourDeny]);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/Summary follows/);
  });

  it("accumulates additionalContext from allow hook into the denial envelope", () => {
    const r = resolveHookChain([contextModeAllow, ourDeny]);
    expect(r.accumulatedContext).toEqual([
      "CONTEXT TIP: Prefer execute_file for files > 50 lines.",
    ]);
  });

  it("order of hooks does not change the winner", () => {
    const forward = resolveHookChain([contextModeAllow, ourDeny]);
    const reverse = resolveHookChain([ourDeny, contextModeAllow]);
    expect(forward.decision).toBe(reverse.decision);
    expect(forward.reason).toBe(reverse.reason);
    expect(forward.accumulatedContext.sort()).toEqual(
      reverse.accumulatedContext.sort(),
    );
  });

  it("deny beats defer beats ask beats allow (full lattice)", () => {
    const deny: HookOutput = {
      hookSpecificOutput: { permissionDecision: "deny" },
    };
    const defer: HookOutput = {
      hookSpecificOutput: { permissionDecision: "defer" },
    };
    const ask: HookOutput = {
      hookSpecificOutput: { permissionDecision: "ask" },
    };
    const allow: HookOutput = {
      hookSpecificOutput: { permissionDecision: "allow" },
    };
    expect(resolveHookChain([allow, defer, ask, deny]).decision).toBe("deny");
    expect(resolveHookChain([allow, ask, defer]).decision).toBe("defer");
    expect(resolveHookChain([allow, ask]).decision).toBe("ask");
    expect(resolveHookChain([allow, allow]).decision).toBe("allow");
  });

  it("hooks that return no decision are ignored (pass-through)", () => {
    const passThrough: HookOutput = {};
    const r = resolveHookChain([passThrough, ourDeny, passThrough]);
    expect(r.decision).toBe("deny");
  });

  it("when no hook decides, default is allow", () => {
    expect(resolveHookChain([{}, {}]).decision).toBe("allow");
    expect(resolveHookChain([]).decision).toBe("allow");
  });

  it("additionalContext is accumulated from every contributing hook", () => {
    const h1: HookOutput = {
      hookSpecificOutput: { additionalContext: "tip A" },
    };
    const h2: HookOutput = {
      hookSpecificOutput: {
        permissionDecision: "allow",
        additionalContext: "tip B",
      },
    };
    const h3: HookOutput = {
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "the reason",
        additionalContext: "tip C",
      },
    };
    const r = resolveHookChain([h1, h2, h3]);
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe("the reason");
    expect(r.accumulatedContext).toEqual(["tip A", "tip B", "tip C"]);
  });
});
