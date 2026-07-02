import { describe, test, expect, afterEach } from "bun:test";
import { loopStep } from "./loop-step.js";
import { parseStateMd, formatStateMd, parseInboxMd, formatInboxMd } from "./state-md.js";
import { loopReducer } from "./loop-reducer.js";
import type { LoopState } from "./types.js";
import { mkdir, rm } from "node:fs/promises";

const TMP = "/tmp/loop-step-test";

async function initLoopDir(): Promise<string> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  return TMP;
}

function emptyState(): LoopState {
  return { loopId: "test", lastRun: null, items: {} };
}

function withTriaged(): LoopState {
  return loopReducer(emptyState(), {
    type: "ADD_ITEM",
    item: { id: "01", source: "ci", summary: "flaky" },
  });
}

function withAwaitingReview(): LoopState {
  let s = withTriaged();
  s = loopReducer(s, { type: "TICK" });
  s = loopReducer(s, { type: "GENERATOR_DONE", itemId: "01" });
  s = loopReducer(s, {
    type: "EVALUATOR_VERDICT",
    itemId: "01",
    verdict: { verdict: "PASS", evidence: "ok" },
  });
  return s;
}

// ============================================================
// TICK
// ============================================================
describe("loopStep — TICK", () => {
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("triaged → fixing, written to STATE.md", async () => {
    const dir = await initLoopDir();
    const state = withTriaged();
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const next = await loopStep({ loopConfigPath: dir });

    expect(next.items["01"]!.step).toBe("fixing");
    const written = parseStateMd(await Bun.file(`${dir}/STATE.md`).text());
    expect(written.items["01"]!.step).toBe("fixing");
  });

  test("empty STATE.md + TICK → unchanged", async () => {
    const dir = await initLoopDir();
    await Bun.write(`${dir}/STATE.md`, formatStateMd(emptyState()));

    const next = await loopStep({ loopConfigPath: dir });
    expect(next.items).toEqual({});
  });

  test("non-triaged items unchanged", async () => {
    const dir = await initLoopDir();
    const state = loopReducer(withTriaged(), { type: "TICK" }); // already fixing
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const next = await loopStep({ loopConfigPath: dir });
    expect(next.items["01"]!.step).toBe("fixing"); // stays fixing, doesn't advance further without generator
  });

  test("missing STATE.md file → starts from empty", async () => {
    const dir = await initLoopDir();
    // Don't create STATE.md

    const next = await loopStep({ loopConfigPath: dir });
    expect(next.items).toEqual({});
    // STATE.md should be created
    const written = await Bun.file(`${dir}/STATE.md`).text();
    expect(written).toContain("## Items");
  });
});

// ============================================================
// APPROVE
// ============================================================
describe("loopStep — APPROVE", () => {
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("awaiting_review → resolved (pruned after write)", async () => {
    const dir = await initLoopDir();
    const state = withAwaitingReview();
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const next = await loopStep({
      loopConfigPath: dir,
      action: { itemId: "01", verdict: "approve" },
    });

    expect(next.items["01"]).toBeUndefined();
    const written = parseStateMd(
      await Bun.file(`${dir}/STATE.md`).text(),
    );
    expect(written.items["01"]).toBeUndefined();
  });
});

// ============================================================
// REJECT_HUMAN
// ============================================================
describe("loopStep — REJECT_HUMAN", () => {
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("awaiting_review → inbox in INBOX.md", async () => {
    const dir = await initLoopDir();
    const state = withAwaitingReview();
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const next = await loopStep({
      loopConfigPath: dir,
      action: { itemId: "01", verdict: "reject", feedback: "wrong approach" },
    });

    expect(next.items["01"]).toBeUndefined();
    const inboxMd = await Bun.file(`${dir}/INBOX.md`).text();
    const inbox = parseInboxMd(inboxMd);
    expect(inbox["01"]!.step).toBe("inbox");
    expect(inbox["01"]!.result).not.toBeNull();
  });
});

// ============================================================
// PROMOTE
// ============================================================
describe("loopStep — PROMOTE", () => {
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("awaiting_review → promoted (pruned)", async () => {
    const dir = await initLoopDir();
    const state = withAwaitingReview();
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const next = await loopStep({
      loopConfigPath: dir,
      action: { itemId: "01", verdict: "promote" },
    });

    expect(next.items["01"]).toBeUndefined();
    const written = parseStateMd(
      await Bun.file(`${dir}/STATE.md`).text(),
    );
    expect(written.items["01"]).toBeUndefined();
  });
});

// ============================================================
// RETRY
// ============================================================
describe("loopStep — RETRY", () => {
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("inbox → fixing in STATE.md, removed from INBOX.md", async () => {
    const dir = await initLoopDir();
    const inboxItems = {
      "01": {
        id: "01",
        source: "ci",
        summary: "flaky",
        step: "inbox" as const,
        attempt: 3,
        priority: 0,
        result: {
          verdict: "REJECT" as const,
          reasons: ["bad"],
          evidence: "",
        },
      },
    };
    await Bun.write(`${dir}/INBOX.md`, formatInboxMd(inboxItems));

    const next = await loopStep({
      loopConfigPath: dir,
      action: { itemId: "01", verdict: "retry" },
    });

    expect(next.items["01"]!.step).toBe("fixing");
    expect(next.items["01"]!.attempt).toBe(1);
    expect(next.items["01"]!.result).toBeNull();
    const inboxMd = await Bun.file(`${dir}/INBOX.md`).text();
    const inbox = parseInboxMd(inboxMd);
    expect(inbox["01"]).toBeUndefined();
  });
});

// ============================================================
// DISMISS
// ============================================================
describe("loopStep — DISMISS", () => {
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("inbox item removed from INBOX.md, other unchanged", async () => {
    const dir = await initLoopDir();
    const inboxItems = {
      "01": {
        id: "01",
        source: "ci",
        summary: "flaky",
        step: "inbox" as const,
        attempt: 3,
        priority: 0,
        result: {
          verdict: "REJECT" as const,
          reasons: ["bad"],
          evidence: "",
        },
      },
      "02": {
        id: "02",
        source: "manual",
        summary: "other",
        step: "inbox" as const,
        attempt: 1,
        priority: 0,
        result: null,
      },
    };
    await Bun.write(`${dir}/INBOX.md`, formatInboxMd(inboxItems));

    await loopStep({
      loopConfigPath: dir,
      action: { itemId: "01", verdict: "dismiss" },
    });

    const inboxMd = await Bun.file(`${dir}/INBOX.md`).text();
    const inbox = parseInboxMd(inboxMd);
    expect(inbox["01"]).toBeUndefined();
    expect(inbox["02"]).toBeDefined();
  });
});

// ============================================================
// Unknown itemId
// ============================================================
describe("loopStep — unknown itemId", () => {
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("action on unknown id → no-op, files unchanged", async () => {
    const dir = await initLoopDir();
    const state = emptyState();
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const next = await loopStep({
      loopConfigPath: dir,
      action: { itemId: "nope", verdict: "approve" },
    });

    expect(next.items).toEqual({});
  });
});
