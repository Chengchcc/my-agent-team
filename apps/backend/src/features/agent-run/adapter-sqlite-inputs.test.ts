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

    expect(await runPort.listPendingInputsForConversation(conversationId)).toHaveLength(0);
    const inputs = await runPort.listInputsForConversation(conversationId);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      runId: acquired.run?.runId,
      message: { text: "start me" },
    });
  });

  test("the queue read reports only what is queued", async () => {
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
    expect(
      (await runPort.listPendingInputsForConversation(conversationId)).map((i) => i.message.text),
    ).toEqual(["second"]);
    // The wider read is not a queue: it carries the promoted input too, oldest first.
    expect(
      (await runPort.listInputsForConversation(conversationId)).map((i) => i.message.text),
    ).toEqual(["first", "second"]);
  });
});
