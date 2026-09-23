import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  getRunCard,
  insertRunCard,
  listActiveRunCards,
  listNonTerminalRunCards,
  openBindings,
  runCardOwnsDelivery,
  runIdFromMessageId,
  updateRunCard,
} from "../bindings-sqlite.js";
import { createCardFlushController } from "./card-flush.js";
import { renderRunCard } from "./card-renderer.js";
import { applyRunEvent, initialRunCardState } from "./card-state.js";
import { finalAnswerText } from "./run-card-watcher.js";

const testDir = `/tmp/test-lark-run-card-${Date.now()}`;
let db: Database;

afterAll(() => {
  db?.close();
});

describe("run_card store (migration 0002)", () => {
  test("openBindings creates run_card and CRUD roundtrips", () => {
    db = openBindings("test-agent", testDir);
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    expect(tables.map((t) => t.name)).toContain("run_card");

    insertRunCard(db, {
      runId: "run-1",
      conversationId: "conv-1",
      larkChatId: "oc_1",
      sourceMessageId: "om_src",
    });
    expect(getRunCard(db, "run-1")?.status).toBe("creating");

    updateRunCard(db, "run-1", {
      status: "streaming",
      accumulated: "hello",
      larkMessageId: "om_card",
    });
    const updated = getRunCard(db, "run-1");
    expect(updated?.status).toBe("streaming");
    expect(updated?.accumulated).toBe("hello");
    expect(updated?.larkMessageId).toBe("om_card");

    expect(listActiveRunCards(db, "oc_1")).toHaveLength(1);
    expect(listNonTerminalRunCards(db)).toHaveLength(1);
  });

  test("runCardOwnsDelivery: every status except fallback_text owns it", () => {
    expect(runCardOwnsDelivery(db, "run-1", "oc_1")).toBe(true);
    updateRunCard(db, "run-1", { status: "completed" });
    expect(runCardOwnsDelivery(db, "run-1", "oc_1")).toBe(true);
    updateRunCard(db, "run-1", { status: "fallback_text" });
    expect(runCardOwnsDelivery(db, "run-1", "oc_1")).toBe(false);
    expect(runCardOwnsDelivery(db, "run-unknown", "oc_1")).toBe(false);
    expect(runCardOwnsDelivery(db, "run-1", "oc_other")).toBe(false);
  });

  test("runIdFromMessageId parses the assistant id format", () => {
    expect(runIdFromMessageId("run:r1:assistant:0")).toBe("r1");
    expect(runIdFromMessageId("msg:conv:human:uuid")).toBeNull();
    expect(runIdFromMessageId("sys:conv:tag:uuid")).toBeNull();
  });
});

describe("applyRunEvent reducer", () => {
  test("text deltas accumulate and clear the HITL wait", () => {
    let s = initialRunCardState();
    s = applyRunEvent(s, { type: "backend.oma.approval_request" });
    expect(s.waiting).toBe("approval");
    s = applyRunEvent(s, { type: "text_delta", text: "hi" });
    expect(s.output).toBe("hi");
    expect(s.waiting).toBeNull();
    s = applyRunEvent(s, { type: "text_delta", text: " there" });
    expect(s.output).toBe("hi there");
  });

  test("tool events: active tool then completed count", () => {
    let s = initialRunCardState();
    s = applyRunEvent(s, { type: "native_tool_started", toolName: "bash" });
    expect(s.activeTool).toBe("bash");
    s = applyRunEvent(s, { type: "native_tool_completed", toolName: "bash" });
    expect(s.activeTool).toBeNull();
    expect(s.toolCount).toBe(1);
  });

  test("ask_requested sets waiting input; running status upgrades phase", () => {
    let s = initialRunCardState();
    expect(s.phase).toBe("queued");
    s = applyRunEvent(s, { type: "status", status: "running" });
    expect(s.phase).toBe("running");
    s = applyRunEvent(s, { type: "backend.oma.ask_requested" });
    expect(s.waiting).toBe("input");
  });

  test("terminal statuses map and freeze the state", () => {
    let s = applyRunEvent(initialRunCardState(), { type: "text_delta", text: "x" });
    s = applyRunEvent(s, { type: "status", status: "aborted" });
    expect(s.terminal?.status).toBe("cancelled");
    s = applyRunEvent(s, { type: "text_delta", text: "y" });
    expect(s.output).toBe("x");
    expect(s.terminal?.status).toBe("cancelled");

    const failed = applyRunEvent(initialRunCardState(), {
      type: "status",
      status: "commit_failed",
    });
    expect(failed.terminal?.status).toBe("failed");

    const done = applyRunEvent(initialRunCardState(), {
      type: "status",
      status: "completed",
    });
    expect(done.terminal?.status).toBe("completed");
  });
});

describe("renderRunCard", () => {
  test("live card: schema 2.0 with streaming config and stop hint", () => {
    const card = renderRunCard(
      { ...initialRunCardState(), phase: "running", output: "working" },
      { runId: "r1", startedAt: Date.now(), webUrl: null },
    );
    const config = card.config as Record<string, unknown>;
    expect(card.schema).toBe("2.0");
    expect(config.streaming_mode).toBe(true);
    expect(JSON.stringify(card)).toContain("发送 /stop 可停止");
    expect(JSON.stringify(card)).not.toContain("在 Web 查看");
  });

  test("terminal card: no streaming, no stop hint, keeps web link", () => {
    const state = applyRunEvent(initialRunCardState(), { type: "status", status: "completed" });
    const card = renderRunCard(state, {
      runId: "r1",
      startedAt: Date.now(),
      webUrl: "http://box:3000/chat/c1",
    });
    const config = card.config as Record<string, unknown>;
    expect(config.streaming_mode).toBeUndefined();
    expect(JSON.stringify(card)).not.toContain("/stop");
    expect(JSON.stringify(card)).toContain("在 Web 查看");
  });

  test("window: output beyond 10k chars keeps the tail only", () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++)
      lines.push(`line-${String(i).padStart(3, "0")}-${"b".repeat(60)}`);
    lines.push("TAIL-MARKER-LINE");
    const output = lines.join("\n"); // ~14k chars across short lines
    const card = renderRunCard(
      { ...initialRunCardState(), phase: "running", output },
      { runId: "r1", startedAt: Date.now(), webUrl: null },
    );
    const json = JSON.stringify(card);
    expect(json).toContain("TAIL-MARKER-LINE");
    expect(json).not.toContain("line-000");
    expect(json).toContain("已折叠");
  });

  test("waiting states pick their own headers", () => {
    const approval = renderRunCard(
      { ...initialRunCardState(), phase: "running", waiting: "approval" },
      { runId: "r1", startedAt: Date.now(), webUrl: null },
    );
    expect(JSON.stringify(approval)).toContain("等待你的确认");
    const ask = renderRunCard(
      { ...initialRunCardState(), phase: "running", waiting: "input" },
      { runId: "r1", startedAt: Date.now(), webUrl: null },
    );
    expect(JSON.stringify(ask)).toContain("等待你的回答");
  });
});

describe("createCardFlushController", () => {
  test("requests during an in-flight flush coalesce into one trailing flush", async () => {
    let flushes = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const controller = createCardFlushController(async () => {
      flushes++;
      if (flushes === 1) await gate;
    });

    controller.request(); // starts flush 1 (blocks on gate)
    controller.request(); // coalesced (needsReflush is set synchronously)
    controller.request(); // coalesced
    release();
    await controller.finish();

    // One blocked flush + exactly one trailing re-flush for the burst.
    expect(flushes).toBe(2);
  });

  test("after finish() no further flushes run", async () => {
    let flushes = 0;
    const controller = createCardFlushController(async () => {
      flushes++;
    });
    controller.request();
    await controller.finish();
    controller.request();
    expect(flushes).toBe(1);
  });
});

describe("finalAnswerText", () => {
  test("last assistant with text wins over earlier ones and non-assistant", () => {
    const text = finalAnswerText([
      { role: "assistant", text: "first" },
      { role: "tool", text: "stdout" },
      { role: "assistant", text: "" },
      { role: "assistant", blocks: [{ type: "text", text: "final answer" }] },
    ]);
    expect(text).toBe("final answer");
  });

  test("null when nothing carries text", () => {
    expect(finalAnswerText([{ role: "assistant", text: " " }])).toBeNull();
    expect(finalAnswerText(null)).toBeNull();
  });
});
