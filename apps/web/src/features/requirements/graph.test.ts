import { describe, expect, test } from "bun:test";
import {
  dispatcherOf,
  filterRequirements,
  type GraphMember,
  isFrontDesk,
  layoutGraph,
  participatingAgents,
  type RunRecord,
  requirementGraph,
  requirementStatusTone,
} from "./graph";
import type { RequirementListRow, RequirementRunFact } from "./queries";

const members: GraphMember[] = [
  { id: "default", name: "Personal Agent", role: null },
  { id: "coder", name: "Coder", role: "worker" },
  { id: "researcher", name: "Researcher", role: "worker" },
];

function run(runId: string, agentId: string | null): RequirementRunFact {
  return { runId, agentId, status: "completed", verification: null, createdAt: 0 };
}

function record(runId: string, agentId: string, authorization: string | null): RunRecord {
  return {
    runId,
    agentId,
    conversationId: `room:${runId}`,
    authorization,
    parentRunId: null,
    status: "completed",
  };
}

describe("participatingAgents", () => {
  test("counts each agent id once, however many runs it executed", () => {
    const runs = [
      run("r1", "coder"),
      run("r2", "coder"),
      run("r3", "researcher"),
      run("r4", "coder"),
    ];
    const result = participatingAgents("default", runs, members);
    expect(result.ids).toEqual(["default", "coder", "researcher"]);
    expect(result.fronts).toEqual(["default"]);
    expect(result.workers).toEqual(["coder", "researcher"]);
  });

  test("the owner that also executed is one participant, not two", () => {
    const result = participatingAgents("coder", [run("r1", "coder")], members);
    expect(result.ids).toEqual(["coder"]);
    expect(result.workers).toEqual(["coder"]);
  });

  test("a run without an agent and an empty owner add nobody", () => {
    const result = participatingAgents("", [run("r1", null)], members);
    expect(result.ids).toEqual([]);
    expect(participatingAgents(null, [], members).ids).toEqual([]);
  });

  test("an agent the registry no longer has reads as a worker", () => {
    const result = participatingAgents(null, [run("r1", "gone")], members);
    expect(result.workers).toEqual(["gone"]);
    expect(isFrontDesk(undefined)).toBeFalsy();
    expect(isFrontDesk(members[0])).toBeTruthy();
  });
});

describe("requirementGraph", () => {
  test("an edge exists only where a dispatch record proves it", () => {
    const runs = [run("r1", "coder"), run("r2", "researcher"), run("r3", "coder")];
    const records = new Map([
      ["r1", record("r1", "coder", "dispatch:default")],
      ["r2", record("r2", "researcher", "user")],
      ["r3", record("r3", "coder", "dispatch:default")],
    ]);
    const graph = requirementGraph({ ownerAgentId: "default", runs, records, members });
    expect(graph.nodes.map((n) => n.id)).toEqual(["default", "coder", "researcher"]);
    expect(graph.edges).toEqual([
      {
        id: "default>coder",
        from: "default",
        to: "coder",
        label: "dispatched",
        sources: ["run:r1", "run:r3"],
      },
    ]);
    const owner = graph.nodes[0];
    const coder = graph.nodes[1];
    expect(owner?.owner).toBeTruthy();
    expect(owner?.dispatcher).toBeTruthy();
    expect(owner?.kind).toBe("front");
    expect(coder?.runIds).toEqual(["r1", "r3"]);
    expect(coder?.owner).toBeFalsy();
  });

  test("a run without a record keeps its worker and loses its dispatcher", () => {
    const graph = requirementGraph({
      ownerAgentId: "default",
      runs: [run("r1", "coder")],
      records: new Map(),
      members,
    });
    expect(graph.nodes.map((n) => n.id)).toEqual(["default", "coder"]);
    expect(graph.edges).toEqual([]);
  });

  test("an agent that dispatched its own run gets no edge to itself", () => {
    const records = new Map([["r1", record("r1", "default", "dispatch:default")]]);
    const graph = requirementGraph({
      ownerAgentId: null,
      runs: [run("r1", "default")],
      records,
      members,
    });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toEqual([]);
  });

  test("a dispatcher that is not the owner joins the graph and is marked", () => {
    const records = new Map([["r1", record("r1", "coder", "dispatch:researcher")]]);
    const graph = requirementGraph({
      ownerAgentId: "default",
      runs: [run("r1", "coder")],
      records,
      members,
    });
    const dispatcher = graph.nodes.find((n) => n.id === "researcher");
    expect(dispatcher?.dispatcher).toBeTruthy();
    expect(dispatcher?.owner).toBeFalsy();
    expect(graph.edges[0]?.sources).toEqual(["run:r1"]);
  });

  test("dispatcherOf reads only the dispatch form", () => {
    expect(dispatcherOf(record("r", "coder", "dispatch:pa-2"))).toBe("pa-2");
    expect(dispatcherOf(record("r", "coder", "dispatch:"))).toBeNull();
    expect(dispatcherOf(record("r", "coder", "user"))).toBeNull();
    expect(dispatcherOf(record("r", "coder", null))).toBeNull();
  });
});

describe("layoutGraph", () => {
  const nodes = [
    { id: "pa", kind: "front" as const, owner: true, dispatcher: true, runIds: [] },
    { id: "w1", kind: "worker" as const, owner: false, dispatcher: false, runIds: ["r1"] },
    { id: "w2", kind: "worker" as const, owner: false, dispatcher: false, runIds: ["r2"] },
  ];
  const edges = [
    { id: "pa>w1", from: "pa", to: "w1", label: "dispatched" as const, sources: ["run:r1"] },
    { id: "pa>w2", from: "pa", to: "w2", label: "dispatched" as const, sources: ["run:r2"] },
  ];

  test("puts the PAs in the row above the workers and never under the minimum width", () => {
    const layout = layoutGraph({ nodes, edges });
    expect(layout.width).toBe(640);
    expect(layout.positions.pa?.y).toBe(20);
    expect(layout.positions.w1?.y).toBeGreaterThan(layout.positions.pa?.y ?? 0);
    expect(layout.positions.w1?.y).toBe(layout.positions.w2?.y);
    expect(layout.positions.w1?.x).toBeLessThan(layout.positions.w2?.x ?? 0);
  });

  test("draws one line per edge and none for an edge to a missing node", () => {
    const layout = layoutGraph({ nodes, edges });
    expect(layout.lines.map((line) => line.id)).toEqual(["pa>w1", "pa>w2"]);
    const orphan = layoutGraph({
      nodes,
      edges: [{ id: "pa>gone", from: "pa", to: "gone", label: "dispatched", sources: [] }],
    });
    expect(orphan.lines).toEqual([]);
  });

  test("a row of one tier is a short canvas", () => {
    const layout = layoutGraph({ nodes: [nodes[0]!], edges: [] });
    expect(layout.height).toBeLessThan(220);
  });
});

describe("filterRequirements", () => {
  const rows = [
    {
      requirementId: "req-a",
      title: "Release checklist",
      goal: "Tidy the release list",
      status: "open",
      projectId: "p1",
      createdByAgentId: "default",
    },
    {
      requirementId: "req-b",
      title: "Research plan",
      goal: "Plan the next round",
      status: "done",
      projectId: null,
      createdByAgentId: "researcher",
    },
  ] as RequirementListRow[];
  const lookups = {
    statusOf: (row: RequirementListRow) => row.status,
    projectNameOf: (projectId: string | null) => (projectId === "p1" ? "Agent Workspace" : ""),
    memberNameOf: (agentId: string | null) => members.find((m) => m.id === agentId)?.name ?? "",
  };
  const none = { query: "", status: "all", projectId: "all" };

  test("passes everything with no filter", () => {
    expect(filterRequirements(rows, none, lookups)).toHaveLength(2);
  });

  test("filters by status and by project", () => {
    expect(
      filterRequirements(rows, { ...none, status: "done" }, lookups).map((r) => r.requirementId),
    ).toEqual(["req-b"]);
    expect(filterRequirements(rows, { ...none, projectId: "p1" }, lookups)).toHaveLength(1);
    expect(filterRequirements(rows, { ...none, projectId: "nope" }, lookups)).toEqual([]);
  });

  test("the search reads goal, project and owner, case-insensitively", () => {
    expect(filterRequirements(rows, { ...none, query: " workspace " }, lookups)).toHaveLength(1);
    expect(filterRequirements(rows, { ...none, query: "researcher" }, lookups)).toHaveLength(1);
    expect(filterRequirements(rows, { ...none, query: "req-b" }, lookups)).toHaveLength(1);
    expect(filterRequirements(rows, { ...none, query: "nothing matches" }, lookups)).toEqual([]);
  });

  test("every view status has a tone", () => {
    const tones = [
      "open",
      "in_progress",
      "waiting_user",
      "pending_acceptance",
      "done",
      "cancelled",
    ].map(requirementStatusTone);
    expect(tones).toEqual(["secondary", "default", "wait", "outline", "default", "destructive"]);
  });
});
