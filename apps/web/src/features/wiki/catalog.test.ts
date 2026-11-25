import { describe, expect, test } from "bun:test";
import type { GraphEdge, GraphNode } from "./catalog";
import { findMaintenanceWorkflow, mostLinked, neighbourhood, outDegree, spaceOf } from "./catalog";

function node(path: string): GraphNode {
  return { path, title: path, status: "draft", maintainedBy: "pa", space: spaceOf(path) };
}

const nodes = [
  node("concepts/retry.md"),
  node("concepts/backoff.md"),
  node("lessons/outage.md"),
  node("personal/pa/notes.md"),
];
const edges: GraphEdge[] = [
  { from: "lessons/outage.md", to: "concepts/retry.md" },
  { from: "lessons/outage.md", to: "concepts/backoff.md" },
  { from: "concepts/retry.md", to: "concepts/backoff.md" },
];

describe("spaceOf", () => {
  test("is the first path segment", () => {
    expect(spaceOf("concepts/retry.md")).toBe("concepts");
    expect(spaceOf("personal/pa/notes.md")).toBe("personal");
    expect(spaceOf("other/x.md")).toBe("other");
  });
});

describe("outDegree", () => {
  test("counts the links a page makes to existing pages", () => {
    expect(outDegree(edges).get("lessons/outage.md")).toBe(2);
    expect(outDegree(edges).get("concepts/backoff.md")).toBeUndefined();
  });
});

describe("mostLinked", () => {
  test("orders by inbound links and leaves unlinked pages out", () => {
    expect(mostLinked(nodes, edges, 3).map((n) => n.path)).toEqual([
      "concepts/backoff.md",
      "concepts/retry.md",
    ]);
    expect(mostLinked(nodes, edges, 1).map((n) => n.path)).toEqual(["concepts/backoff.md"]);
  });
});

describe("neighbourhood", () => {
  test("keeps the page, its neighbours and only the edges between them", () => {
    const around = neighbourhood(nodes, edges, "concepts/retry.md");
    expect(around.nodes.map((n) => n.path).sort()).toEqual([
      "concepts/backoff.md",
      "concepts/retry.md",
      "lessons/outage.md",
    ]);
    expect(around.edges).toHaveLength(3);
  });
  test("a page with no links is a graph of one", () => {
    const around = neighbourhood(nodes, edges, "personal/pa/notes.md");
    expect(around.nodes.map((n) => n.path)).toEqual(["personal/pa/notes.md"]);
    expect(around.edges).toEqual([]);
  });
});

describe("findMaintenanceWorkflow", () => {
  test("finds the workflow by id or tag, else nothing", () => {
    const nightly = { workflowId: "wiki-lint", tags: ["maintenance"] };
    const tagged = { workflowId: "nightly-job", tags: ["Wiki"] };
    const other = { workflowId: "deploy", tags: ["ops"] };
    expect(findMaintenanceWorkflow([other, nightly])).toBe(nightly);
    expect(findMaintenanceWorkflow([other, tagged])).toBe(tagged);
    expect(findMaintenanceWorkflow([other])).toBeNull();
  });
});
