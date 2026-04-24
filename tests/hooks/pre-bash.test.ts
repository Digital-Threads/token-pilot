/**
 * v0.28.0 — PreToolUse:Bash advisor tests.
 *
 * Each blocking heuristic has its own describe block. Focus: no false
 * positives on bounded / scoped versions of the same command.
 */
import { describe, it, expect } from "vitest";
import {
  detectHeavyPattern,
  decidePreBash,
  renderPreBashOutput,
} from "../../src/hooks/pre-bash.ts";

describe("detectHeavyPattern — grep -r", () => {
  it("blocks unbounded grep -r", () => {
    const d = detectHeavyPattern("grep -r foo src/");
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.reason).toMatch(/find_usages/);
  });

  it("blocks grep -R too", () => {
    expect(detectHeavyPattern("grep -R bar .").kind).toBe("deny");
  });

  it("allows grep -r with -m bound", () => {
    expect(detectHeavyPattern("grep -r -m 20 foo src/").kind).toBe("allow");
  });

  it("allows grep without -r (non-recursive)", () => {
    expect(detectHeavyPattern("grep foo src/file.ts").kind).toBe("allow");
  });
});

describe("detectHeavyPattern — find /", () => {
  it("blocks find / without -maxdepth", () => {
    expect(detectHeavyPattern("find / -name '*.ts'").kind).toBe("deny");
  });

  it("blocks find ~ without -maxdepth", () => {
    expect(detectHeavyPattern("find ~ -type f").kind).toBe("deny");
  });

  it("allows find / with -maxdepth", () => {
    expect(detectHeavyPattern("find / -maxdepth 3 -name '*.conf'").kind).toBe(
      "allow",
    );
  });

  it("allows find on scoped directory", () => {
    expect(detectHeavyPattern("find src -name '*.ts'").kind).toBe("allow");
  });
});

describe("detectHeavyPattern — cat on code files", () => {
  it("blocks cat on .ts file", () => {
    expect(detectHeavyPattern("cat src/foo.ts").kind).toBe("deny");
  });

  it("blocks cat on .py file", () => {
    expect(detectHeavyPattern("cat main.py").kind).toBe("deny");
  });

  it("allows cat on non-code file", () => {
    expect(detectHeavyPattern("cat README.md").kind).toBe("allow");
    expect(detectHeavyPattern("cat config.json").kind).toBe("allow");
  });

  it("allows cat in a pipeline (likely piping to head/grep)", () => {
    expect(detectHeavyPattern("cat src/foo.ts | head -20").kind).toBe("allow");
  });
});

describe("detectHeavyPattern — git log", () => {
  it("blocks git log without -n", () => {
    expect(detectHeavyPattern("git log").kind).toBe("deny");
    expect(detectHeavyPattern("git log --oneline").kind).toBe("deny");
  });

  it("allows git log -n N", () => {
    expect(detectHeavyPattern("git log -n 20").kind).toBe("allow");
  });

  it("allows git log --max-count", () => {
    expect(detectHeavyPattern("git log --max-count=10").kind).toBe("allow");
  });

  it("allows git log | head", () => {
    expect(detectHeavyPattern("git log --oneline | head -20").kind).toBe(
      "allow",
    );
  });

  // v0.30.3 — short-form positional limit. Regression from a user report:
  // `git log --oneline -5` is canonical git syntax and was incorrectly
  // flagged as unbounded because the heuristic only knew -n/-N/--max-count.
  it("allows short-form -N max-count (git log -5)", () => {
    expect(detectHeavyPattern("git log -5").kind).toBe("allow");
    expect(detectHeavyPattern("git log --oneline -5").kind).toBe("allow");
    expect(detectHeavyPattern("git log --oneline -10 --stat").kind).toBe(
      "allow",
    );
    expect(detectHeavyPattern("git log -100 --graph").kind).toBe("allow");
  });

  it("still blocks git log with flags that are NOT max-count bounds", () => {
    // -p (patch) shouldn't be mistaken for a bound
    expect(detectHeavyPattern("git log -p").kind).toBe("deny");
    // --stat alone isn't a bound either
    expect(detectHeavyPattern("git log --stat").kind).toBe("deny");
  });

  // v0.30.4 — regression from a commit-message false positive: the
  // heuristic used /\bgit\s+log\b/ which matched anywhere in the string.
  // A literal `git commit -m "... git log ..."` then tripped the rule
  // because "git log" appeared inside the message. Anchor the pattern to
  // command-start or post-separator position instead.
  it("ignores literal 'git log' that appears inside a quoted message", () => {
    expect(
      detectHeavyPattern('git commit -m "bump: fixes git log heuristic"').kind,
    ).toBe("allow");
    expect(
      detectHeavyPattern(
        `git commit -m "$(cat <<'EOF'\nreplace git log with smart_log\nEOF\n)"`,
      ).kind,
    ).toBe("allow");
  });

  it("still catches git log after a chained separator", () => {
    expect(detectHeavyPattern("cd repo && git log").kind).toBe("deny");
    expect(detectHeavyPattern("git status; git log").kind).toBe("deny");
  });
});

describe("detectHeavyPattern — git diff", () => {
  it("blocks bare git diff", () => {
    expect(detectHeavyPattern("git diff").kind).toBe("deny");
  });

  it("allows git diff with a path", () => {
    expect(detectHeavyPattern("git diff src/foo.ts").kind).toBe("allow");
  });

  it("allows git diff --stat", () => {
    expect(detectHeavyPattern("git diff --stat").kind).toBe("allow");
  });
});

describe("detectHeavyPattern — catch-all", () => {
  it("allows arbitrary safe commands", () => {
    expect(detectHeavyPattern("ls").kind).toBe("allow");
    expect(detectHeavyPattern("pwd").kind).toBe("allow");
    expect(detectHeavyPattern("npm run build").kind).toBe("allow");
    expect(detectHeavyPattern("node --version").kind).toBe("allow");
  });

  it("allows empty command", () => {
    expect(detectHeavyPattern("").kind).toBe("allow");
  });
});

describe("decidePreBash integration", () => {
  it("non-Bash tool → allow", () => {
    expect(decidePreBash({ tool_name: "Read" }).kind).toBe("allow");
  });

  it("Bash with missing command → allow", () => {
    expect(decidePreBash({ tool_name: "Bash", tool_input: {} }).kind).toBe(
      "allow",
    );
  });

  it("Bash with heavy command → deny", () => {
    expect(
      decidePreBash({
        tool_name: "Bash",
        tool_input: { command: "grep -r foo ." },
      }).kind,
    ).toBe("deny");
  });
});

describe("detectHeavyPattern — composite escape patterns (v0.29.0)", () => {
  it('blocks bash -c "cat src/foo.ts"', () => {
    const d = detectHeavyPattern('bash -c "cat src/foo.ts"');
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.reason).toMatch(/smart_read/);
  });

  it('blocks sh -c "grep -r foo ."', () => {
    const d = detectHeavyPattern('sh -c "grep -r foo ."');
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.reason).toMatch(/find_usages|grep -r/);
  });

  it('blocks eval "cat src/foo.ts"', () => {
    const d = detectHeavyPattern('eval "cat src/foo.ts"');
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.reason).toMatch(/smart_read/);
  });

  it("blocks for f in *.ts; do cat $f; done (body has heavy call)", () => {
    const d = detectHeavyPattern("for f in *.ts; do cat $f.ts; done");
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.reason).toMatch(/smart_read/);
  });

  it("blocks while read f; do git log; done (heavy in loop body)", () => {
    const d = detectHeavyPattern("while read f; do git log; done");
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.reason).toMatch(/smart_log/);
  });

  it("allows wrapper with benign inner (bash -c with ls)", () => {
    expect(detectHeavyPattern('bash -c "ls -la"').kind).toBe("allow");
  });

  it("allows eval of benign command", () => {
    expect(detectHeavyPattern('eval "echo hello"').kind).toBe("allow");
  });
});

describe("decidePreBash — enforcement mode", () => {
  it("advisory mode: heavy grep -r → allow (no blocking)", () => {
    const d = decidePreBash(
      { tool_name: "Bash", tool_input: { command: "grep -r foo src/" } },
      "advisory",
    );
    expect(d.kind).toBe("allow");
  });

  it("advisory mode: unbounded git log → allow (no blocking)", () => {
    const d = decidePreBash(
      { tool_name: "Bash", tool_input: { command: "git log" } },
      "advisory",
    );
    expect(d.kind).toBe("allow");
  });

  it("deny mode (default): heavy grep -r → deny", () => {
    const d = decidePreBash(
      { tool_name: "Bash", tool_input: { command: "grep -r foo src/" } },
      "deny",
    );
    expect(d.kind).toBe("deny");
  });

  it("strict mode: heavy grep -r → deny (same as deny)", () => {
    const d = decidePreBash(
      { tool_name: "Bash", tool_input: { command: "grep -r foo src/" } },
      "strict",
    );
    expect(d.kind).toBe("deny");
  });

  it("advisory mode: non-Bash tool → allow (unchanged)", () => {
    const d = decidePreBash({ tool_name: "Read" }, "advisory");
    expect(d.kind).toBe("allow");
  });
});

describe("renderPreBashOutput", () => {
  it("allow → null", () => {
    expect(renderPreBashOutput({ kind: "allow" })).toBeNull();
  });

  it("deny → valid PreToolUse JSON", () => {
    const json = renderPreBashOutput({ kind: "deny", reason: "stop" })!;
    const parsed = JSON.parse(json);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe("stop");
  });

  // v0.30.0 — advisory kind (used for test-runner nudge toward test_summary)
  it("advise → permissionDecision=allow + additionalContext", () => {
    const json = renderPreBashOutput({ kind: "advise", reason: "hint" })!;
    const parsed = JSON.parse(json);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(parsed.hookSpecificOutput.additionalContext).toBe("hint");
  });
});

// v0.30.0 — redirect common test runners to test_summary. Tool-audit
// 2026-04-24 showed test_summary=0 calls across three projects; every
// agent runs `npm test` or `pytest` directly and lets raw output flood
// the context.
describe("test-runner → test_summary (pre-bash advisory)", () => {
  const cases: Array<{ cmd: string; label: string }> = [
    { cmd: "npm test", label: "bare npm test" },
    { cmd: "npm run test", label: "npm run test" },
    { cmd: "npm run test:unit", label: "npm run test:unit (suite variant)" },
    { cmd: "yarn test", label: "yarn test" },
    { cmd: "pnpm test", label: "pnpm test" },
    { cmd: "pnpm run test:api", label: "pnpm run test:api" },
    { cmd: "yarn workspace @x/api test", label: "yarn workspace test" },
    { cmd: "npx vitest run", label: "npx vitest" },
    { cmd: "pnpx jest", label: "pnpx jest" },
    { cmd: "vitest", label: "bare vitest" },
    { cmd: "jest --coverage", label: "bare jest with flag" },
    { cmd: "pytest tests/", label: "pytest with path" },
    { cmd: "phpunit", label: "bare phpunit" },
    { cmd: "go test ./...", label: "go test" },
    { cmd: "cargo test --release", label: "cargo test" },
  ];
  for (const { cmd, label } of cases) {
    it(`advises on: ${label}`, () => {
      const decision = decidePreBash(
        { tool_name: "Bash", tool_input: { command: cmd } },
        "deny",
      );
      expect(decision.kind, `cmd="${cmd}"`).toBe("advise");
      if (decision.kind === "advise") {
        expect(decision.reason).toContain("test_summary");
      }
    });
  }

  const negatives = [
    "echo test",
    "node test-helper.js",
    "mkdir test-fixtures",
    "ls tests/",
    "cat test.json",
  ];
  for (const cmd of negatives) {
    it(`does NOT advise on innocuous command: ${cmd}`, () => {
      const decision = decidePreBash(
        { tool_name: "Bash", tool_input: { command: cmd } },
        "deny",
      );
      expect(decision.kind, `cmd="${cmd}"`).toBe("allow");
    });
  }
});
