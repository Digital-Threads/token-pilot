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
});
