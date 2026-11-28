import { describe, expect, test } from "bun:test";
import type { WorkflowDefinition } from "@chengchenccc/workflow";
import {
  definitionOf,
  type ProposalRead,
  proposalNotice,
  proposalStep,
  sameDefinition,
  settlementOf,
  stableJson,
  workflowProposalMeta,
} from "./proposal-draft";

const saved: WorkflowDefinition = {
  version: 1,
  id: "lint",
  meta: { name: "Nightly lint", status: "draft" },
  nodes: [
    { id: "start", type: "start" },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [{ from: "start", to: "done" }],
};

const withGate: WorkflowDefinition = {
  ...saved,
  nodes: [...saved.nodes, { id: "gate", type: "human", question: "Ship it?" }],
  edges: [...saved.edges, { from: "gate", to: "done" }],
};

function proposalOf(id: string, payload: unknown): ProposalRead {
  const proposal: ProposalRead = { id, payload };
  return proposal;
}

describe("stableJson and sameDefinition", () => {
  test("the key order of either side does not matter", () => {
    const reordered = {
      edges: saved.edges,
      nodes: saved.nodes,
      id: "lint",
      version: 1,
      meta: saved.meta,
    };
    expect(stableJson(reordered)).toBe(stableJson(saved));
    expect(sameDefinition(reordered, saved)).toBeTruthy();
  });

  test("a different node, or nothing, is not the same definition", () => {
    expect(sameDefinition(withGate, saved)).toBeFalsy();
    expect(sameDefinition(null, saved)).toBeFalsy();
    expect(sameDefinition(undefined, undefined)).toBeTruthy();
  });
});

describe("definitionOf", () => {
  test("takes a payload that has nodes and edges, unwraps ADR 0084 envelopes, and refuses anything else", () => {
    expect(definitionOf(saved)?.id).toBe("lint");
    const wrapped = {
      definition: saved,
      requiresApprovalFor: ["script", "cron"],
      scriptNodes: [{ id: "s1", code: "export default () => ({ ok: true });", timeoutMs: 3000 }],
      cronTriggers: ["0 3 * * *"],
      summary: "add check",
    };
    expect(definitionOf(wrapped)?.id).toBe("lint");
    expect(workflowProposalMeta(wrapped)).toEqual({
      requiresApprovalFor: ["script", "cron"],
      scriptNodes: [{ id: "s1", code: "export default () => ({ ok: true });", timeoutMs: 3000 }],
      cronTriggers: ["0 3 * * *"],
      summary: "add check",
    });
    expect(workflowProposalMeta(saved)).toBeNull();
    expect(definitionOf({ id: "lint" })).toBeNull();
    expect(definitionOf("lint")).toBeNull();
    expect(definitionOf(null)).toBeNull();
  });
});

describe("proposalNotice", () => {
  const open = { saved, loadedId: null, dirty: false, settledId: null };

  test("nothing pending, or a payload that is no definition", () => {
    expect(proposalNotice({ ...open, proposal: null })).toBe("none");
    expect(proposalNotice({ ...open, proposal: proposalOf("p1", { hello: 1 }) })).toBe("none");
  });

  test("a proposal that says what is saved is saved, even when the key order differs", () => {
    const reordered = {
      meta: saved.meta,
      edges: saved.edges,
      nodes: saved.nodes,
      version: 1,
      id: "lint",
    };
    const notice = proposalNotice({ ...open, proposal: proposalOf("p1", reordered) });
    expect(notice).toBe("saved");
  });

  test("a loaded proposal is in the draft while the draft is dirty; otherwise it is aside", () => {
    const waiting = { ...open, proposal: proposalOf("p1", withGate), loadedId: "p1" };
    expect(proposalNotice({ ...waiting, dirty: true })).toBe("in-draft");
    // The person undid the proposal: the draft is the saved definition again, so it is not in it.
    expect(proposalNotice({ ...waiting, dirty: false })).toBe("aside");
    const unloaded = { ...open, proposal: proposalOf("p1", withGate), dirty: true };
    expect(proposalNotice({ ...unloaded, loadedId: null })).toBe("aside");
    expect(proposalNotice({ ...unloaded, loadedId: "p0" })).toBe("aside");
  });

  test("a settled proposal reads as settled until another one arrives", () => {
    const settled = { ...open, settledId: "p1" };
    expect(proposalNotice({ ...settled, proposal: null })).toBe("settled");
    // The row is still what the last poll returned, so it must not read as waiting again.
    const cached = {
      ...settled,
      proposal: proposalOf("p1", withGate),
      dirty: true,
      loadedId: "p1",
    };
    expect(proposalNotice(cached)).toBe("settled");
    expect(proposalNotice({ ...settled, proposal: proposalOf("p2", withGate) })).toBe("aside");
  });
});

describe("proposalStep", () => {
  test("a proposal that differs loads as a draft while the draft is clean", () => {
    const step = proposalStep({
      proposal: proposalOf("p1", withGate),
      seenId: null,
      saved,
      clean: true,
    });
    expect(step.kind).toBe("load");
    if (step.kind !== "load") {
      throw new Error("expected a load step");
    }
    expect(step.id).toBe("p1");
    expect(step.draft).toEqual(withGate);
  });

  test("a proposal already saved is never a dirty draft again", () => {
    const step = proposalStep({
      proposal: proposalOf("p1", saved),
      seenId: null,
      saved,
      clean: true,
    });
    expect(step.kind).toBe("saved");
  });

  test("over unsaved edits the proposal waits; it is handled once", () => {
    const waiting = proposalStep({
      proposal: proposalOf("p1", withGate),
      seenId: null,
      saved,
      clean: false,
    });
    expect(waiting.kind).toBe("aside");
    const again = proposalStep({
      proposal: proposalOf("p1", withGate),
      seenId: "p1",
      saved,
      clean: true,
    });
    expect(again.kind).toBe("ignore");
    const next = proposalStep({
      proposal: proposalOf("p2", withGate),
      seenId: "p1",
      saved,
      clean: true,
    });
    expect(next.kind).toBe("load");
  });

  test("nothing pending, or no definition saved yet, is ignored", () => {
    expect(proposalStep({ proposal: null, seenId: null, saved, clean: true }).kind).toBe("ignore");
    expect(
      proposalStep({ proposal: proposalOf("p1", "text"), seenId: null, saved, clean: true }).kind,
    ).toBe("ignore");
  });
});

describe("settlementOf", () => {
  test("a saved definition that is the proposal settles it as adopted, key order ignored", () => {
    const reordered = {
      edges: saved.edges,
      nodes: saved.nodes,
      version: 1,
      id: "lint",
      meta: saved.meta,
    };
    expect(settlementOf(saved, proposalOf("p1", reordered))).toBe("adopted");
  });

  test("a changed node before saving settles it as discarded", () => {
    expect(settlementOf(withGate, proposalOf("p1", saved))).toBe("discarded");
    expect(settlementOf(saved, proposalOf("p1", withGate))).toBe("discarded");
  });

  test("nothing to settle without a proposal, a saved definition, or a definition in the payload", () => {
    expect(settlementOf(saved, null)).toBeNull();
    expect(settlementOf(null, proposalOf("p1", saved))).toBeNull();
    expect(settlementOf(saved, proposalOf("p1", "text"))).toBeNull();
  });
});
