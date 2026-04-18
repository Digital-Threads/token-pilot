/**
 * TP-hsz batch A — `session_budget` MCP tool.
 *
 * Returns a compact JSON-shaped block the agent can read to decide how
 * aggressively to economise tokens in the rest of the session:
 *   - savedTokens for this session (from hook-events.jsonl)
 *   - configured adaptive budget
 *   - burn fraction (0..1, clamped)
 *   - effective threshold the adaptive curve would apply right now
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSessionBudget } from "../../src/handlers/session-budget.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "tp-budget-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function event(sessionId: string, saved: number): string {
  return (
    JSON.stringify({
      ts: Date.now(),
      session_id: sessionId,
      agent_type: null,
      agent_id: null,
      event: "denied",
      file: "foo.ts",
      lines: 500,
      estTokens: saved + 100,
      summaryTokens: 100,
      savedTokens: saved,
    }) + "\n"
  );
}

async function seedEvents(projectRoot: string, lines: string[]): Promise<void> {
  const dir = join(projectRoot, ".token-pilot");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "hook-events.jsonl"), lines.join(""));
}

describe("handleSessionBudget", () => {
  it("reports zero burn when no events exist yet", async () => {
    const res = await handleSessionBudget({ sessionId: "sess-1" }, tempDir, {
      baseThreshold: 300,
      adaptiveThreshold: true,
      adaptiveBudgetTokens: 100_000,
    });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.sessionId).toBe("sess-1");
    expect(payload.savedTokens).toBe(0);
    expect(payload.burnFraction).toBe(0);
    expect(payload.effectiveThreshold).toBe(300);
    expect(payload.adaptive).toBe(true);
  });

  it("computes burn fraction from hook-events.jsonl", async () => {
    await seedEvents(tempDir, [
      event("sess-1", 20_000),
      event("sess-1", 20_000),
      event("other", 90_000), // different session — ignored
    ]);
    const res = await handleSessionBudget({ sessionId: "sess-1" }, tempDir, {
      baseThreshold: 300,
      adaptiveThreshold: true,
      adaptiveBudgetTokens: 100_000,
    });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.savedTokens).toBe(40_000);
    expect(payload.burnFraction).toBeCloseTo(0.4, 2);
    expect(payload.effectiveThreshold).toBe(225); // base × 0.75
  });

  it("returns base threshold when adaptive is disabled", async () => {
    await seedEvents(tempDir, [event("sess-1", 95_000)]);
    const res = await handleSessionBudget({ sessionId: "sess-1" }, tempDir, {
      baseThreshold: 300,
      adaptiveThreshold: false,
      adaptiveBudgetTokens: 100_000,
    });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.burnFraction).toBeCloseTo(0.95, 2);
    expect(payload.effectiveThreshold).toBe(300);
    expect(payload.adaptive).toBe(false);
  });

  it("clamps burn fraction at 1.0", async () => {
    await seedEvents(tempDir, [event("sess-1", 500_000)]);
    const res = await handleSessionBudget({ sessionId: "sess-1" }, tempDir, {
      baseThreshold: 300,
      adaptiveThreshold: true,
      adaptiveBudgetTokens: 100_000,
    });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.burnFraction).toBe(1);
    expect(payload.effectiveThreshold).toBe(90); // base × 0.3
  });

  it("handles missing sessionId gracefully", async () => {
    const res = await handleSessionBudget({ sessionId: "" }, tempDir, {
      baseThreshold: 300,
      adaptiveThreshold: true,
      adaptiveBudgetTokens: 100_000,
    });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.sessionId).toBe("");
    expect(payload.savedTokens).toBe(0);
    expect(payload.effectiveThreshold).toBe(300);
  });
});
