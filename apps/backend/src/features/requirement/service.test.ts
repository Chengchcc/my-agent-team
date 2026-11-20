import { describe, expect, test } from "bun:test";
import type { RequirementPort } from "./adapter-sqlite.js";
import type { RequirementRow } from "./domain.js";
import { deriveRequirementStatus } from "./domain.js";
import { createRequirementService, type RequirementService } from "./service.js";

/** The in-memory double, with the row store exposed for assertions. */
interface PortWithRows extends RequirementPort {
  rows: RequirementRow[];
}

function makePort(seed: RequirementRow[] = []): PortWithRows {
  const rows = [...seed];
  const base: RequirementPort = {
    create: (row) => {
      rows.push(row);
      return row;
    },
    get: (id) => rows.find((r) => r.requirementId === id) ?? null,
    update: (id, patch, now) => {
      const row = rows.find((r) => r.requirementId === id);
      if (!row) return null;
      Object.assign(row, patch, { updatedAt: now });
      return row;
    },
    list: (includeClosed) =>
      [...rows]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .filter((r) => includeClosed || r.status === "open"),
    listOpenByConversation: (conversationId, limit) =>
      rows
        .filter((r) => r.originConversationId === conversationId && r.status === "open")
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit),
    runsOf: () => [],
    requestsOf: () => [],
  };
  return { ...base, rows };
}

function svcWith(seed: RequirementRow[] = []): { svc: RequirementService; port: PortWithRows } {
  const port = makePort(seed);
  let n = 0;
  const svc = createRequirementService({
    port,
    idGen: () => `req-${++n}`,
    now: () => 1_000,
  });
  return { svc, port };
}

const row = (over: Partial<RequirementRow> = {}): RequirementRow => ({
  requirementId: "req-x",
  title: "t",
  goal: "g",
  background: null,
  constraints: null,
  expectedDeliverables: null,
  acceptanceCriteria: null,
  status: "open",
  originConversationId: "c1",
  originSeq: null,
  createdByAgentId: "pa",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe("ADR 0074: derived requirement status", () => {
  test("a live run means work, regardless of summaries", () => {
    expect(
      deriveRequirementStatus(
        "open",
        [{ runId: "r", agentId: "w", status: "running", verification: null, createdAt: 1 }],
        [],
      ),
    ).toBe("in_progress");
  });

  test("an unresolved human request means waiting for the user", () => {
    expect(
      deriveRequirementStatus(
        "open",
        [{ runId: "r", agentId: "w", status: "waiting", verification: null, createdAt: 1 }],
        [{ actionId: "a", runId: "r", kind: "ask", status: "pending", head: "which db?" }],
      ),
    ).toBe("waiting_user");
  });

  test("passed verification means acceptance is the only thing left", () => {
    expect(
      deriveRequirementStatus(
        "open",
        [{ runId: "r", agentId: "w", status: "completed", verification: "passed", createdAt: 1 }],
        [],
      ),
    ).toBe("pending_acceptance");
  });

  test("a stored terminal beats everything; no runs means open", () => {
    expect(deriveRequirementStatus("done", [], [])).toBe("done");
    expect(deriveRequirementStatus("cancelled", [], [])).toBe("cancelled");
    expect(deriveRequirementStatus("open", [], [])).toBe("open");
  });
});

describe("ADR 0074: which item a dispatch belongs to", () => {
  test("a named-but-unknown id refuses; it must not silently fall back", () => {
    const { svc } = svcWith([row({ requirementId: "req-open", createdAt: 50 })]);
    expect(() =>
      svc.resolveForDispatch({
        requirementId: "req-named",
        conversationId: "c1",
        agentId: "pa",
        briefTitle: "fix login",
        briefGoal: "fix the login spin",
      }),
    ).toThrow(/not found/); // falling back to the open item would dispatch under the wrong goal
  });

  test("an unnamed dispatch continues the conversation's newest OPEN item", () => {
    const { svc } = svcWith([
      row({ requirementId: "req-old", createdAt: 10 }),
      row({ requirementId: "req-new", createdAt: 90 }),
      row({ requirementId: "req-done", createdAt: 99, status: "done" }),
    ]);
    const item = svc.resolveForDispatch({
      conversationId: "c1",
      agentId: "pa",
      briefTitle: "also add tests",
      briefGoal: "add tests",
    });
    expect(item.requirementId).toBe("req-new"); // not the done one, not the older one
  });

  test("with nothing open, the brief itself opens a new item", () => {
    const { svc, port } = svcWith([]);
    const item = svc.resolveForDispatch({
      conversationId: "c1",
      agentId: "pa",
      briefTitle: "fix login spin",
      briefGoal: "stop the spinner",
      acceptance: "bun test passes",
    });
    expect(port.rows).toHaveLength(1);
    expect(item.goal).toBe("stop the spinner");
    expect(item.acceptanceCriteria).toBe("bun test passes");
    expect(item.originConversationId).toBe("c1");
  });
});
