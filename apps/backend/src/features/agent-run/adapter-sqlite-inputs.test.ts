/** A promoted input leaves the pending list, and the projection still needs it afterwards: a turn
 *  that is now history was started by an input that is no longer queued. */
import { describe, expect, test } from "bun:test";
import { runPort, setupBranch } from "./adapter-sqlite.harness.js";

describe("Agent Run: conversation inputs", () => {
  test("an accepted input is readable for history after leaving the pending list", async () => {
    const { conversationId, agentId, branch } = await setupBranch("inputs1");
    const acquired = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "start me" },
      inputIdempotencyKey: "ikey-inputs1",
      runIdempotencyKey: "rkey-inputs1",
      deliveryIdempotencyKey: "dkey-inputs1",
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    expect(acquired.run).toBeTruthy();

    const pending = await runPort.listPendingInputsForConversation(conversationId);
    const all = await runPort.listPendingInputsForConversation(conversationId, {
      includeDelivered: true,
    });
    expect(pending).toHaveLength(0);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ runId: acquired.run?.runId, message: { text: "start me" } });
  });

  test("the pending list still reports what is queued", async () => {
    const { conversationId, agentId, branch } = await setupBranch("inputs2");
    await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: "ikey-inputs2-1",
      runIdempotencyKey: "rkey-inputs2-1",
      deliveryIdempotencyKey: "dkey-inputs2-1",
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "second" },
      inputIdempotencyKey: "ikey-inputs2-2",
      runIdempotencyKey: "rkey-inputs2-2",
      deliveryIdempotencyKey: "dkey-inputs2-2",
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const pending = await runPort.listPendingInputsForConversation(conversationId);
    expect(pending.map((input) => input.message.text)).toEqual(["second"]);
  });
});
