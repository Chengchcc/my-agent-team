import { describe, expect, test } from "bun:test";
import { mapRunEvent } from "./mapping.js";

describe("delegation event mapping", () => {
  test("delegation lifecycle events map 1:1 to core events", () => {
    expect(
      mapRunEvent({
        id: 1,
        type: "delegation_batch_started",
        data: { batchId: "wf1", label: "audit", agentCount: 12 },
      }),
    ).toEqual({ type: "delegation_batch_started", batchId: "wf1", label: "audit", agentCount: 12 });
    expect(
      mapRunEvent({
        id: 2,
        type: "delegation_agent_started",
        data: { batchId: "wf1", agentId: "a1", label: "src/a.ts" },
      }),
    ).toEqual({
      type: "delegation_agent_started",
      batchId: "wf1",
      agentId: "a1",
      label: "src/a.ts",
    });
    expect(
      mapRunEvent({
        id: 3,
        type: "delegation_agent_completed",
        data: { batchId: "wf1", agentId: "a1", label: "src/a.ts", ok: true },
      }),
    ).toEqual({
      type: "delegation_agent_completed",
      batchId: "wf1",
      agentId: "a1",
      label: "src/a.ts",
      ok: true,
    });
    expect(
      mapRunEvent({
        id: 4,
        type: "delegation_batch_completed",
        data: { batchId: "wf1", ok: false, agentCount: 12, totalTokens: 500 },
      }),
    ).toEqual({
      type: "delegation_batch_completed",
      batchId: "wf1",
      ok: false,
      agentCount: 12,
      totalTokens: 500,
    });
  });

  test("an errored agent carries error + usage through", () => {
    const ev = mapRunEvent({
      id: 5,
      type: "delegation_agent_completed",
      data: {
        batchId: "wf2",
        agentId: "a2",
        label: "x",
        ok: false,
        error: "boom",
        usage: { totalTokens: 10 },
      },
    });
    expect(ev).toEqual({
      type: "delegation_agent_completed",
      batchId: "wf2",
      agentId: "a2",
      label: "x",
      ok: false,
      error: "boom",
      usage: { totalTokens: 10 },
    });
  });
});
