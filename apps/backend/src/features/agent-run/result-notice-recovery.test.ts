import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../infra/sqlite/db.js";
import { createAgentContextService, sqliteAgentContextAdapter } from "../agent-context/index.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import { sqliteAgentRunAdapter } from "./adapter-sqlite.js";
import { createAgentRunService } from "./service.js";

/** ADR 0060 D6: the notice lives between the terminal commit and the delivery.
 *  Recovery re-delivers whatever was never confirmed; this pins the selection
 *  (who qualifies) and the mark (confirming once is enough). */

let runPort: ReturnType<typeof sqliteAgentRunAdapter>;
let backend: ReturnType<typeof createAgentRunService>;

const CONV = "conv-notice";
const AGENT = "ag-notice";

async function createRun(authorization: string, parentRunId?: string): Promise<string> {
  const acq = await backend.enqueueAndAcquire({
    conversationId: CONV,
    agentId: AGENT,
    backendKind: "oma",
    mode: "normal",
    message: { role: "user", text: "go" },
    defaultModel: { backendKind: "oma", modelId: "fake/echo" },
    configRevision: 1,
    idempotencyKey: `notice-${Math.random().toString(36).slice(2, 8)}`,
    authorization,
    ...(parentRunId ? { parentRunId } : {}),
  });
  return acq.run!.runId;
}

beforeEach(() => {
  const dataDir = mkdtempSync(join(tmpdir(), "phase6-notice-"));
  const db = openDb(`${dataDir}/backend.db`);
  const convPort = sqliteConversationAdapter(db);
  const contextPort = sqliteAgentContextAdapter(db, {
    ulid: () => `ctx-${Math.random().toString(36).slice(2, 8)}`,
  });
  const ledgerResolver = {
    async resolveMessage(cid: string, seq: number) {
      const hit = convPort.getLedgerEntry(cid, seq);
      return hit ? (hit.content as never) : null;
    },
  };
  runPort = sqliteAgentRunAdapter(db, {
    contextPort,
    ledgerResolver,
    idGen: { ulid: () => `r-${Math.random().toString(36).slice(2, 8)}` },
  });
  const contextSvc = createAgentContextService({
    port: contextPort,
    idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
    ledgerResolver,
  });
  backend = createAgentRunService({
    port: runPort,
    contextService: contextSvc,
    idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
    ledgerResolver,
  });
  convPort.createConversation({ conversationId: CONV, agentId: AGENT, createdAt: Date.now() });
});

describe("ADR 0060 result-notice recovery selection", () => {
  test("a terminal dispatched run without a mark is picked up exactly once", async () => {
    const runId = await createRun("dispatch:lead", "front-run");
    await runPort.finalizeRun(runId, { status: "failed", error: "boom" });

    const first = await runPort.listUnnotifiedDispatchedTerminalRuns(50);
    expect(first.map((r) => r.runId)).toEqual([runId]);

    await runPort.markResultNotified(runId);
    const second = await runPort.listUnnotifiedDispatchedTerminalRuns(50);
    expect(second).toEqual([]);
  });

  test("non-dispatch bases are never re-delivered", async () => {
    // We only owe a notice to a dispatcher. Handback already woke them through
    // the tool; result: runs are the dispatcher answering.
    // One branch serializes: create then terminal each before the next.
    for (const [authorization, parent] of [
      ["handback:worker", "front-run"],
      ["result:worker", "worker-run"],
      ["user", undefined],
    ] as const) {
      const id = await createRun(authorization, parent);
      await runPort.finalizeRun(id, { status: "failed", error: "x" });
    }
    const listed = await runPort.listUnnotifiedDispatchedTerminalRuns(50);
    expect(listed).toEqual([]);
  });

  test("a still-running dispatched run is not swept (it has no terminal yet)", async () => {
    const runId = await createRun("dispatch:lead", "front-run");
    const listed = await runPort.listUnnotifiedDispatchedTerminalRuns(50);
    expect(listed.map((r) => r.runId)).not.toContain(runId);
  });

  test("a dispatched run without a parent is not a re-delivery candidate", async () => {
    // A dispatch basis without parent_run_id is a legacy row: the notice has
    // nobody to travel to, so recovery must not invent a recipient.
    const runId = await createRun("dispatch:lead");
    await runPort.finalizeRun(runId, { status: "failed", error: "x" });
    const listed = await runPort.listUnnotifiedDispatchedTerminalRuns(50);
    expect(listed.map((r) => r.runId)).not.toContain(runId);
  });
});
