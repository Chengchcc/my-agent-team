import { describe, expect, test } from "bun:test";
import { swapAckReaction } from "./ack-reaction.js";
import type { CardKitClient } from "./card-kit.js";

interface Call {
  op: string;
  args: unknown[];
}

/** Records calls; the reaction methods are the only ones exercised. */
function fakeClient(over: { removeOk?: boolean; addOk?: boolean } = {}) {
  const calls: Call[] = [];
  const client = {
    addReaction: async (messageId: string, emojiType: string) => {
      calls.push({ op: "addReaction", args: [messageId, emojiType] });
      return over.addOk === false
        ? { ok: false as const, error: "code 231001: bad emoji", retryable: false }
        : { ok: true as const, reactionId: `r-${emojiType}` };
    },
    removeReaction: async (messageId: string, reactionId: string) => {
      calls.push({ op: "removeReaction", args: [messageId, reactionId] });
      return over.removeOk === false
        ? { ok: false as const, error: "HTTP 500", retryable: true }
        : { ok: true as const };
    },
  } as unknown as CardKitClient;
  return { calls, client };
}

describe("swapAckReaction", () => {
  test("takes the acknowledgement back BEFORE leaving the DONE", async () => {
    const { calls, client } = fakeClient();
    const outcome = await swapAckReaction(client, { messageId: "om_1", ackReactionId: "r-OnIt" });
    expect(outcome).toEqual({ removed: true, marked: true });
    expect(calls.map((c) => c.op)).toEqual(["removeReaction", "addReaction"]);
    expect(calls[0]!.args).toEqual(["om_1", "r-OnIt"]);
    expect(calls[1]!.args).toEqual(["om_1", "DONE"]);
  });

  test("no acknowledgement recorded (ack failed earlier): only the DONE is left", async () => {
    const { calls, client } = fakeClient();
    const outcome = await swapAckReaction(client, { messageId: "om_1", ackReactionId: null });
    expect(outcome).toEqual({ removed: false, marked: true });
    expect(calls.map((c) => c.op)).toEqual(["addReaction"]);
  });

  test("a failed retraction still leaves the DONE, and reports the failure", async () => {
    // The reaction is cosmetic; a failure to clean it up must not cost the
    // user the terminal signal.
    const { calls, client } = fakeClient({ removeOk: false });
    const outcome = await swapAckReaction(client, { messageId: "om_1", ackReactionId: "r-OnIt" });
    expect(outcome.removed).toBe(false);
    expect(outcome.marked).toBe(true);
    expect(outcome.error).toContain("removeReaction");
    expect(calls.map((c) => c.op)).toEqual(["removeReaction", "addReaction"]);
  });

  test("a failed DONE is reported without claiming success", async () => {
    const { client } = fakeClient({ addOk: false });
    const outcome = await swapAckReaction(client, { messageId: "om_1", ackReactionId: null });
    expect(outcome.marked).toBe(false);
    expect(outcome.error).toContain("doneReaction");
  });
});
