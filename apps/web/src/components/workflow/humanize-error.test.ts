import { beforeEach, describe, expect, test } from "bun:test";
import { setLocale } from "@/lib/i18n";
import { humanizeWorkflowError } from "./humanize-error";

const failed = [{ nodeId: "build", status: "failed" }];

/** Wrapping the sentences in `t()` must not change a word of the English. */
describe("humanizeWorkflowError", () => {
  beforeEach(() => {
    setLocale("en");
  });

  test("nothing to say without an error", () => {
    expect(humanizeWorkflowError(undefined, [])).toBeNull();
    expect(humanizeWorkflowError("", [])).toBeNull();
  });

  test("an input artifact is missing", () => {
    const said = humanizeWorkflowError(
      "node lint missing required input artifact: artifacts://in.json",
      [],
    );
    expect(said?.title).toBe("Artifact required by node lint does not exist");
    expect(said?.detail).toBe(
      "You must provide artifacts://in.json before running. Upload it on the Artifacts page, or pick the correct address in the input field at run time.",
    );
  });

  test("the workflow's own input artifact is missing", () => {
    const said = humanizeWorkflowError(
      "workflow nightly input artifact artifacts://in.json does not exist: artifacts://wrong.json",
      [],
    );
    expect(said?.title).toBe("Input artifact artifacts://in.json does not exist");
    expect(said?.detail).toBe(
      "The artifacts://wrong.json provided for this run was not found in the artifact store. Upload it first, or check the address spelling.",
    );
  });

  test("a node did not produce what it declared", () => {
    const said = humanizeWorkflowError(
      "node lint missing required output artifact: artifacts://out.json",
      [],
    );
    expect(said?.title).toBe("Node lint did not produce the declared artifact");
    expect(said?.detail).toBe(
      "This node promised to produce artifacts://out.json, but it does not exist after execution. The agent needs to call artifact_upload to upload the artifact before the workflow can continue.",
    );
  });

  test("a node's output does not match its declaration", () => {
    const said = humanizeWorkflowError("node lint output invalid: expected string, got number", []);
    expect(said?.title).toBe("Node lint output format is invalid");
    expect(said?.detail).toBe(
      "expected string, got number. Relax the output declaration in the node properties, or adjust the prompt so the agent outputs as required, then retry.",
    );
  });

  test("a script or an agent node failed", () => {
    const script = humanizeWorkflowError(
      "script failed (exit 1): TypeError: boom\n    at run (step.js:1)",
      failed,
    );
    expect(script?.title).toBe("Script node build failed");
    expect(script?.detail).toBe("TypeError: boom");
    expect(humanizeWorkflowError("script failed (exit 1): x", [])?.title).toBe(
      "Script node ? failed",
    );

    const timedOut = humanizeWorkflowError("agent run r1 ended timeout", failed);
    expect(timedOut?.title).toBe("Agent node build timed out");
    expect(humanizeWorkflowError("agent run r1 ended failed", failed)?.title).toBe(
      "Agent node build failed",
    );
    expect(timedOut?.detail).toBe(
      "Expand the agent conversation in the Trace view to see what happened; or increase retries and run again.",
    );
  });

  test("the workflow has no runnable next step", () => {
    const said = humanizeWorkflowError("stuck: no ready nodes", []);
    expect(said?.title).toBe("Workflow stuck: no runnable next step");
    expect(said?.detail).toBe(
      "Usually this means no edge condition matched. Check the condition expressions at the branch against the node outputs.",
    );
  });

  test("anything else is quoted, cut to 160 characters", () => {
    expect(humanizeWorkflowError("boom", [])?.title).toBe("boom");
    expect(humanizeWorkflowError("x".repeat(200), [])?.title).toHaveLength(160);
  });

  test("the sentences follow the locale", () => {
    setLocale("zh");
    const missing = humanizeWorkflowError(
      "node lint missing required input artifact: artifacts://in.json",
      [],
    );
    expect(missing?.title).toBe(
      "\u8282\u70b9 lint \u9700\u8981\u7684\u4ea7\u7269\u4e0d\u5b58\u5728",
    );
    expect(humanizeWorkflowError("script failed (exit 1): x", failed)?.title).toBe(
      "\u811a\u672c\u8282\u70b9 build \u5931\u8d25",
    );
    expect(humanizeWorkflowError("agent run r1 ended timeout", failed)?.title).toBe(
      "\u6210\u5458\u8282\u70b9 build \u5df2\u8d85\u65f6",
    );
  });
});
