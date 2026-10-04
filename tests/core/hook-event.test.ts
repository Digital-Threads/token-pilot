/**
 * Hook-event records built without Node, so the Claude Code mod writes the
 * same lines into hook-events.jsonl as the CLI hooks do.
 */
import { describe, it, expect } from "vitest";
import {
  ROTATION_THRESHOLD_BYTES,
  diagnosticEvent,
  shouldRotate,
  tagEvent,
} from "../../src/core/hook-event.ts";

describe("hook-event builders", () => {
  it("builds a diagnostic record", () => {
    expect(diagnosticEvent({ code: "bash_denied", detail: { command: "cat a.ts" } }, 123)).toMatchObject({
      ts: 123,
      session_id: "diagnostic",
      event: "diagnostic",
      level: "info",
      code: "bash_denied",
      detail: { command: "cat a.ts" },
    });
  });

  it("tags workflow and task ids from the env it is given; explicit ids win", () => {
    const base = diagnosticEvent({ code: "x" }, 1);

    expect(tagEvent(base, { TOKEN_PILOT_WORKFLOW_ID: "wf1", LOOM_TASK_ID: "t1" })).toMatchObject({
      workflow_id: "wf1",
      task_id: "t1",
    });
    expect(tagEvent({ ...base, workflow_id: "own" }, { TOKEN_PILOT_WORKFLOW_ID: "wf1" }).workflow_id).toBe("own");
    expect(tagEvent(base, {})).toEqual(base);
  });
});

describe("event log rotation", () => {
  it("rotates at the threshold", () => {
    expect(shouldRotate({ size: ROTATION_THRESHOLD_BYTES - 1 })).toBe(false);
    expect(shouldRotate({ size: ROTATION_THRESHOLD_BYTES })).toBe(true);
  });
});
