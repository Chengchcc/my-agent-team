import { describe, expect, test } from "bun:test";
import type { WorkflowDefinition } from "@chengchenccc/workflow";
import { definitionFacts } from "./definition-facts";
import {
  blankWorkflow,
  copyWorkflowDefinition,
  inputKindOf,
  newWorkflowRequest,
  paramHintOf,
  runInput,
  slugifyWorkflowId,
  workflowRequest,
} from "./draft";

describe("slugifyWorkflowId", () => {
  test("makes a readable id and refuses a name with nothing to keep", () => {
    expect(slugifyWorkflowId("  Release Verification Flow! ")).toBe("release-verification-flow");
    expect(slugifyWorkflowId("---")).toBe("");
    expect(slugifyWorkflowId("\u6d41\u7a0b")).toBe("");
  });
});

describe("paramHintOf", () => {
  test("reads a bare word and a schema object, list or not", () => {
    expect(paramHintOf("number")).toBe("number");
    expect(paramHintOf({ type: ["boolean", "null"] })).toBe("boolean");
    expect(paramHintOf({ type: "object" })).toBe("string");
    expect(paramHintOf(undefined)).toBe("string");
  });
});

describe("blankWorkflow", () => {
  test("is a valid draft with a start and an end", () => {
    const facts = definitionFacts(blankWorkflow("my-flow", "My flow", ""));
    expect(facts.valid).toBeTruthy();
    expect(facts.nodeCount).toBe(2);
    expect(facts.edgeCount).toBe(1);
    expect(facts.trigger.mode).toBe("manual");
    expect(facts.status).toBe("draft");
  });

  test("keeps a description only when one was given", () => {
    expect(blankWorkflow("a", "A", "  ").meta?.description).toBeUndefined();
    expect(blankWorkflow("a", "A", " Does things ").meta?.description).toBe("Does things");
  });
});

describe("copyWorkflowDefinition", () => {
  const source: WorkflowDefinition = {
    version: 1,
    id: "nightly",
    meta: { name: "Nightly", status: "active", owner: "system" },
    triggers: [{ type: "cron", cron: "0 4 * * *" }],
    nodes: [
      { id: "start", type: "start" },
      { id: "done", type: "end", status: "success" },
    ],
    edges: [{ from: "start", to: "done" }],
  };

  test("copies the graph under the new name and drops the schedule", () => {
    const copy = copyWorkflowDefinition(source, "daytime", "Daytime");
    expect(copy.id).toBe("daytime");
    expect(copy.meta).toEqual({ name: "Daytime", status: "draft", owner: "system" });
    expect(copy.triggers).toEqual([]);
    expect(copy.nodes).toEqual(source.nodes);
    expect(source.triggers).toHaveLength(1);
  });
});

describe("inputKindOf and runInput", () => {
  test("an artifact field is named apart from the other kinds", () => {
    expect(inputKindOf("artifact")).toBe("artifact");
    expect(inputKindOf({ type: ["number", "null"] })).toBe("number");
    expect(inputKindOf(undefined)).toBe("string");
  });

  test("sends what was typed, in the field's own type, and leaves empty fields out", () => {
    const params = [
      { key: "repo", type: "string" },
      { key: "tries", type: "number" },
      { key: "dryRun", type: "boolean" },
      { key: "brief", type: "artifact" },
      { key: "skipped", type: "string" },
    ];
    const sent = runInput(params, {
      repo: "team/website",
      tries: "3",
      dryRun: "false",
      brief: "artifacts://briefs/today.md",
    });
    expect(sent.input).toEqual({
      repo: "team/website",
      tries: 3,
      dryRun: false,
      brief: "artifacts://briefs/today.md",
    });
    expect(sent.artifacts).toEqual(["artifacts://briefs/today.md"]);
    expect(runInput(params, {}).input).toEqual({});
  });
});

describe("composer requests", () => {
  test("the editor's request names the workflow and its goal, and leads with the skill", () => {
    const text = workflowRequest("lint", "Check the wiki", "/workflow_design");
    expect(text.startsWith("/workflow_design\n<workflow-context>\n")).toBeTruthy();
    expect(text).toContain("<workflowId>lint</workflowId>");
    expect(text).toContain("<goal>Check the wiki</goal>");
    expect(text.endsWith("My request: ")).toBeTruthy();
  });

  test("the new-workflow request says nothing is created, and has no skill line without a skill", () => {
    const text = newWorkflowRequest("Lint", "  Check the wiki ", "");
    expect(text.startsWith('I am about to create a workflow named "Lint".')).toBeTruthy();
    expect(text).toContain("What it is for: Check the wiki\n");
    expect(text).toContain("Nothing is created by this message");
    const bare = newWorkflowRequest("Lint", "", "");
    expect(bare.includes("What it is for")).toBeFalsy();
  });
});
