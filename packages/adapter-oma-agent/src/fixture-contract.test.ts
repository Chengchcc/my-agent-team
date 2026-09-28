import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mapRunEvent, mapRunOutcome } from "./event-mapper.js";
import { codingAgentOutputSchema } from "./protocol.js";

/** Fixture contract (ADR 0024): the REAL oma child emitted this JSONL.
 *  The adapter's local parser/mapping must consume it without drift. */
const FIXTURE = new URL("../../../apps/oh-my-agent/fixtures/rpc-basic.jsonl", import.meta.url)
  .pathname;

describe("oma wire fixture contract", () => {
  test("adapter parses and maps the real child fixture", () => {
    const lines = readFileSync(FIXTURE, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    const outputs = lines.map((l) => codingAgentOutputSchema.parse(JSON.parse(l)));
    expect(outputs.some((o) => o.type === "response" && o.success === true)).toBe(true);
    expect(outputs.some((o) => o.type === "event")).toBe(true);
    expect(outputs[outputs.length - 1]?.type).toBe("outcome");

    for (const output of outputs) {
      if (output.type === "event") {
        expect(mapRunEvent(output.event).type).toBeTruthy();
      }
      if (output.type === "outcome") {
        expect(mapRunOutcome(output.outcome).status).toBe("completed");
      }
    }
  });

  // ADR 0039 decision 1: approval is a product contract, so the child's
  // oma-namespaced `approval_request` frame must land on the core event. If
  // this mapping is dropped the frame silently falls through to the
  // `backend.oma.*` default instead - and the backend, which keys the durable
  // pending action on the core name, stops persisting approvals at all.
  test("the child's approval frame maps onto the CORE approval event", () => {
    const mapped = mapRunEvent({
      id: 7,
      type: "approval_request",
      data: {
        callId: "call_00_abc",
        toolName: "bash",
        reason: "bash requested approval (permission)",
        input: { command: "rm -rf build" },
        sandboxed: false,
        deadlineAt: 1_800_000_000_000,
      },
    });
    expect(mapped).toEqual({
      type: "approval_requested",
      payload: {
        callId: "call_00_abc",
        toolName: "bash",
        reason: "bash requested approval (permission)",
        input: { command: "rm -rf build" },
        sandboxed: false,
        deadlineAt: 1_800_000_000_000,
      },
    });
    // Absent optional fields stay absent: a stamped default (false, 0) would
    // make the card claim a sandbox state nobody reported.
    expect(
      mapRunEvent({ id: 8, type: "approval_request", data: { callId: "c", toolName: "bash" } }),
    ).toEqual({ type: "approval_requested", payload: { callId: "c", toolName: "bash" } });
  });
});
