import { describe, expect, test } from "bun:test";
import type { ProposalRow } from "./domain.js";
import type { ProposalPort } from "./ports.js";
import { createProposalService } from "./service.js";

function memoryPort(): ProposalPort & { rows: ProposalRow[] } {
  const rows: ProposalRow[] = [];
  return {
    rows,
    insert(row) {
      rows.push({ ...row, status: "pending", resolvedAt: null });
    },
    latestPending(kind, targetId) {
      return (
        [...rows]
          .reverse()
          .find((r) => r.kind === kind && r.targetId === targetId && r.status === "pending") ?? null
      );
    },
    resolve(id, status, resolvedAt) {
      const row = rows.find((r) => r.id === id && r.status === "pending");
      if (!row) return false;
      row.status = status;
      row.resolvedAt = resolvedAt;
      return true;
    },
  };
}

function serviceOf(port: ProposalPort) {
  let n = 0;
  return createProposalService({ port, idGen: () => `p${++n}`, now: () => 1000 + n });
}

describe("proposals", () => {
  test("a proposal is readable while it is pending", () => {
    const service = serviceOf(memoryPort());
    const made = service.propose("agent_config", "agent-1", { name: "x" });
    expect(service.pending("agent_config", "agent-1")).toEqual(made);
    // Another target (or another kind) does not see it.
    expect(service.pending("agent_config", "agent-2")).toBeNull();
    expect(service.pending("workflow_definition", "agent-1")).toBeNull();
  });

  test("the newest pending proposal is the one a page adopts", () => {
    const service = serviceOf(memoryPort());
    service.propose("workflow_definition", "wf-1", { first: true });
    const second = service.propose("workflow_definition", "wf-1", { second: true });
    expect(service.pending("workflow_definition", "wf-1")).toEqual(second);
  });

  test("resolving moves a proposal out of pending exactly once", () => {
    const service = serviceOf(memoryPort());
    const made = service.propose("agent_config", "agent-1", { name: "x" });
    expect(service.resolve(made.id, "adopted")).toBe(true);
    expect(service.pending("agent_config", "agent-1")).toBeNull();
    // A second click — or a second page — is not a second decision.
    expect(service.resolve(made.id, "discarded")).toBe(false);
  });

  test("a row whose kind nobody recognises is dropped, not guessed at", () => {
    const port = memoryPort();
    port.rows.push({
      id: "p9",
      kind: "something_else",
      targetId: "agent-1",
      payload: "{}",
      status: "pending",
      createdAt: 1,
      resolvedAt: null,
    });
    expect(serviceOf(port).pending("agent_config", "agent-1")).toBeNull();
  });

  test("a payload that is not JSON is dropped rather than handed on half-shaped", () => {
    const port = memoryPort();
    port.rows.push({
      id: "p8",
      kind: "agent_config",
      targetId: "agent-1",
      payload: "{not json",
      status: "pending",
      createdAt: 1,
      resolvedAt: null,
    });
    expect(serviceOf(port).pending("agent_config", "agent-1")).toBeNull();
  });
});
