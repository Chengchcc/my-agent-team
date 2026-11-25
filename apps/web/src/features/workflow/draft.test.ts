import { describe, expect, test } from "bun:test";
import type { WorkflowDefinition } from "@chengchenccc/workflow";
import { definitionFacts } from "./definition-facts";
import { blankWorkflow, copyWorkflowDefinition, paramHintOf, slugifyWorkflowId } from "./draft";

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
