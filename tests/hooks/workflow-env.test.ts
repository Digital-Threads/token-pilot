/**
 * 1.0.2 audit, item 17 — the mod and the event tagger count a Loom run
 * (LOOM_WORKFLOW_ID) as a workflow; the command hooks' activeWorkflowId did
 * not, so pre-task attached no budget note there.
 */
import { describe, expect, it } from "vitest";
import { activeWorkflowId } from "../../src/core/workflow.ts";
import { tagEvent } from "../../src/core/hook-event.ts";

describe("workflow id from the environment", () => {
  it("the command hooks see a Loom workflow", () => {
    expect(activeWorkflowId({ LOOM_WORKFLOW_ID: "wf-loom" } as NodeJS.ProcessEnv)).toBe("wf-loom");
  });

  it("agrees with the event tagger on every name it reads", () => {
    for (const name of ["TOKEN_PILOT_WORKFLOW_ID", "CLAUDE_CODE_WORKFLOW_ID", "LOOM_WORKFLOW_ID"]) {
      const env = { [name]: "wf-1" };
      const tagged = tagEvent({ ts: 1, event: "denied" } as never, env).workflow_id;
      expect(activeWorkflowId(env as NodeJS.ProcessEnv)).toBe(tagged);
    }
  });
});
