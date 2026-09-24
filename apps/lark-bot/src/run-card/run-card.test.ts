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
import { handleCardActionLine } from "./card-actions.js";
import { createCardFlushController } from "./card-flush.js";
import { renderRunCard } from "./card-renderer.js";
import { applyRunEvent, initialRunCardState, toolActivity } from "./card-state.js";
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
    s = applyRunEvent(s, { type: "backend.oma.approval_request", payload: { callId: "c" } });
    expect(s.waiting).toBe("approval");
    s = applyRunEvent(s, { type: "text_delta", text: "hi" });
    expect(s.output).toBe("hi");
    expect(s.waiting).toBeNull();
    expect(s.pendingAction).toBeNull();
    s = applyRunEvent(s, { type: "text_delta", text: " there" });
    expect(s.output).toBe("hi there");
  });

  test("tool events: active label, archived steps with outcomes", () => {
    let s = initialRunCardState();
    // These fixtures carry no activity (the wire field is optional), so the
    // label degrades to the tool name — the card used to map names onto
    // invented Chinese labels, which claimed knowledge it did not have.
    s = applyRunEvent(s, { type: "native_tool_started", toolName: "bash" });
    expect(s.activeTool?.label).toBe("正在调用 bash");
    expect(s.phase).toBe("tool_running");
    s = applyRunEvent(s, { type: "native_tool_completed", toolName: "bash", result: {} });
    expect(s.activeTool).toBeNull();
    expect(s.completedTools).toEqual([{ label: "正在调用 bash", outcome: "success" }]);
    const failed = applyRunEvent(s, {
      type: "native_tool_completed",
      toolName: "bash",
      result: { isError: true },
    });
    expect(failed.completedTools[1]).toEqual({ label: "正在调用 bash", outcome: "error" });
  });

  test("thinking sets a phase word only; never stores text", () => {
    let s = applyRunEvent(initialRunCardState(), { type: "thinking_delta", text: "secret" });
    expect(s.phase).toBe("thinking");
    expect(s.output).toBe("");
    s = applyRunEvent(s, { type: "text_delta", text: "answer" });
    expect(s.phase).toBe("streaming");
    expect(s.output).toBe("answer");
  });

  test("approval_request keeps the callId in pendingAction", () => {
    const s = applyRunEvent(initialRunCardState(), {
      type: "backend.oma.approval_request",
      payload: { callId: "call-1" },
    });
    expect(s.waiting).toBe("approval");
    expect(s.pendingAction?.callId).toBe("call-1");
    expect(s.pendingAction?.kind).toBe("approval");
  });

  test("ask_requested sets waiting ask with parsed question; running upgrades phase", () => {
    let s = initialRunCardState();
    expect(s.phase).toBe("queued");
    s = applyRunEvent(s, { type: "status", status: "running" });
    expect(s.phase).toBe("streaming");
    s = applyRunEvent(s, {
      type: "backend.oma.ask_requested",
      payload: {
        callId: "c1",
        questions: [
          {
            id: "q1",
            question: "选择分支",
            kind: "select",
            options: [{ label: "main", value: "main" }],
          },
        ],
      },
    });
    expect(s.waiting).toBe("ask");
    expect(s.pendingAction?.prompt).toBe("选择分支");
    expect(s.pendingAction?.options).toEqual([{ label: "main", value: "main" }]);
    expect(s.pendingAction?.questionId).toBe("q1");
  });

  test("todo_update uses the producer's vocabulary — done/cancelled are kept", () => {
    const state = applyRunEvent(initialRunCardState(), {
      type: "backend.oma.todo_update",
      payload: {
        items: [
          { id: "t1", text: "读代码", status: "done" },
          { id: "t2", text: "改代码", status: "in_progress" },
          { id: "t3", text: "别做", status: "cancelled" },
          { id: "t4", text: "待办", status: "pending" },
          { id: "bad", text: "缺状态" },
        ],
      },
    });
    // The oma todo plugin emits done/cancelled, not "completed" — a
    // card-local vocabulary silently dropped every finished step.
    expect(state.todos.map((t) => t.status)).toEqual([
      "done",
      "in_progress",
      "cancelled",
      "pending",
    ]);
    const content = JSON.stringify(
      renderRunCard(state, { runId: "r1", startedAt: Date.now(), webUrl: null }),
    );
    expect(content).toContain("✓ 读代码");
    expect(content).toContain("● 改代码");
    expect(content).toContain("✗ 别做");
    expect(content).toContain("○ 待办");
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
  test("live card: streaming config, stop button, process strip", () => {
    const state = {
      ...initialRunCardState(),
      phase: "tool_running" as const,
      output: "working",
      activeTool: { label: "正在执行：bun test apps/backend", startedAt: Date.now() },
      completedTools: [{ label: "正在读取：src/main.ts", outcome: "success" as const }],
    };
    const card = renderRunCard(state, { runId: "r1", startedAt: Date.now(), webUrl: null });
    const config = card.config as Record<string, unknown>;
    expect(card.schema).toBe("2.0");
    expect(config.streaming_mode).toBe(true);
    const json = JSON.stringify(card);
    expect(json).toContain("stop_button");
    // The strip prints the activity line verbatim (the child already
    // prefixed it), so there is no "正在：" + "正在执行：" double prefix.
    expect(json).toContain("🧪 正在执行：bun test apps/backend");
    expect(json).toContain("✓ 正在读取：src/main.ts");
    expect(json).not.toContain("在 Web 查看");
  });

  test("waiting approval swaps stop for approve/reject buttons", () => {
    const state = {
      ...initialRunCardState(),
      phase: "streaming" as const,
      waiting: "approval" as const,
      pendingAction: {
        callId: "call-9",
        kind: "approval" as const,
        prompt: "",
        options: [],
        allowFreeText: false,
        questionId: "",
      },
    };
    const card = renderRunCard(state, { runId: "r1", startedAt: Date.now(), webUrl: null });
    const json = JSON.stringify(card);
    expect(json).toContain("approve_button");
    expect(json).toContain("reject_button");
    expect(json).toContain("call-9");
    expect(json).not.toContain("stop_button");
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
      { ...initialRunCardState(), phase: "streaming", waiting: "ask" },
      { runId: "r1", startedAt: Date.now(), webUrl: null },
    );
    expect(JSON.stringify(ask)).toContain("等待你的回答");
  });

  test("body elements use real element tags — plain_text breaks the PATCH (230099/200621)", () => {
    const live = renderRunCard(
      {
        ...initialRunCardState(),
        phase: "tool_running",
        output: "x",
        activeTool: { label: "执行命令", startedAt: Date.now() },
        completedTools: [{ label: "读取文件", outcome: "success" }],
      },
      { runId: "r1", startedAt: Date.now(), webUrl: null },
    );
    const liveBody = live.body as { elements: Array<{ tag: string }> };
    expect(liveBody.elements.length).toBeGreaterThan(1); // tool summary present
    for (const el of liveBody.elements) expect(el.tag).not.toBe("plain_text");

    const failed = applyRunEvent(initialRunCardState(), {
      type: "status",
      status: "failed",
      error: "boom",
    });
    const failedCard = renderRunCard(failed, {
      runId: "r1",
      startedAt: Date.now(),
      webUrl: null,
    });
    const failedBody = failedCard.body as { elements: Array<{ tag: string }> };
    for (const el of failedBody.elements) expect(el.tag).not.toBe("plain_text");
    expect(JSON.stringify(failedCard)).toContain("boom");
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

describe("handleCardActionLine (ADR 0031 callback trust model)", () => {
  /** lark-cli flattens card.action.trigger into top-level snake_case keys
   *  (Go struct tag `action_value` = "Developer-defined action value as JSON
   *  string"), so the fixture mirrors that shape rather than Lark's nested
   *  action.value schema. */
  function callbackLine(fields: Record<string, string>): string {
    return JSON.stringify({
      event_id: fields.event_id,
      event_type: "card.action.trigger",
      operator_id: fields.operator_id,
      chat_id: fields.chat_id,
      message_id: fields.message_id,
      action_tag: fields.action_tag,
      action_value: fields.action_value,
    });
  }

  function seedCard(runId: string, messageId: string): void {
    insertRunCard(db, {
      runId,
      conversationId: `conv-${runId}`,
      larkChatId: "oc_actions",
      sourceMessageId: "om_src",
    });
    updateRunCard(db, runId, { status: "streaming", larkMessageId: messageId });
  }

  function deps() {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        db,
        cancelRun: async (runId: string) => {
          calls.push(`cancel:${runId}`);
          return {};
        },
        resolveApproval: async (runId: string, callId: string, decision: string) => {
          calls.push(`approval:${runId}:${callId}:${decision}`);
          return {};
        },
        resolveAsk: async (input: {
          runId: string;
          callId: string;
          questionId: string;
          selectedValue: string;
        }) => {
          calls.push(
            `ask:${input.runId}:${input.callId}:${input.questionId}:${input.selectedValue}`,
          );
          return {};
        },
        log: () => {},
      },
    };
  }

  test("answer_ask decodes and resolves the question through the shared ask path", async () => {
    seedCard("run-ask", "om_ask");
    const { calls, deps: d } = deps();
    const outcome = await handleCardActionLine(
      callbackLine({
        event_id: "ev-ask",
        operator_id: "ou_1",
        chat_id: "oc_actions",
        message_id: "om_ask",
        action_tag: "button",
        action_value: JSON.stringify({
          runId: "run-ask",
          callId: "call-ask",
          questionId: "q1",
          selectedValue: "main",
          action: "answer_ask",
        }),
      }),
      d,
    );
    expect(outcome).toBe("answered");
    expect(calls).toEqual(["ask:run-ask:call-ask:q1:main"]);
  });

  test("a callback whose chat does not own the card is rejected", async () => {
    seedCard("run-mismatch", "om_mismatch");
    const { calls, deps: d } = deps();
    const outcome = await handleCardActionLine(
      callbackLine({
        event_id: "ev-mismatch",
        operator_id: "ou_1",
        chat_id: "oc_someone_else",
        message_id: "om_mismatch",
        action_tag: "button",
        action_value: JSON.stringify({ runId: "run-mismatch", action: "stop" }),
      }),
      d,
    );
    expect(outcome).toBe("rejected");
    expect(calls).toEqual([]);
  });

  test("a callback for an unknown message never reaches the backend", async () => {
    const { calls, deps: d } = deps();
    const outcome = await handleCardActionLine(
      callbackLine({
        event_id: "ev-unknown",
        operator_id: "ou_1",
        chat_id: "oc_actions",
        message_id: "om_nobody",
        action_tag: "button",
        action_value: JSON.stringify({ runId: "run-ask", action: "stop" }),
      }),
      d,
    );
    expect(outcome).toBe("rejected");
    expect(calls).toEqual([]);
  });

  test("a replayed event id is deduped before any backend call", async () => {
    seedCard("run-dup", "om_dup");
    const { calls, deps: d } = deps();
    const line = callbackLine({
      event_id: "ev-dup",
      operator_id: "ou_1",
      chat_id: "oc_actions",
      message_id: "om_dup",
      action_tag: "button",
      action_value: JSON.stringify({ runId: "run-dup", action: "stop" }),
    });
    expect(await handleCardActionLine(line, d)).toBe("stopped");
    expect(await handleCardActionLine(line, d)).toBe("duplicate");
    expect(calls).toEqual(["cancel:run-dup"]);
  });
});

describe("tool activity (surfaces display, never invent)", () => {
  test("toolActivity prefers the child's line and never invents one", () => {
    expect(toolActivity("正在执行：bun test apps/backend", "bash")).toBe(
      "正在执行：bun test apps/backend",
    );
    // No activity → the tool name is the only honest thing left.
    expect(toolActivity(undefined, "bash")).toBe("正在调用 bash");
    expect(toolActivity(undefined, undefined)).toBe("正在调用 工具");
    // MCP names are readable, but nothing about their args is claimed.
    expect(toolActivity(undefined, "mcp__github__create_issue")).toBe(
      "正在调用 github · create_issue",
    );
  });

  test("the process strip shows the activity line for a native tool", () => {
    const state = applyRunEvent(initialRunCardState(), {
      type: "native_tool_started",
      toolName: "bash",
      callId: "c1",
      activity: "正在执行：bun test apps/backend",
    });
    expect(state.activeTool?.label).toBe("正在执行：bun test apps/backend");
    const content = JSON.stringify(
      renderRunCard(state, { runId: "r1", startedAt: Date.now(), webUrl: null }),
    );
    expect(content).toContain("正在执行：bun test apps/backend");
  });

  test("a tool without activity degrades to its name, not a guessed summary", () => {
    const state = applyRunEvent(initialRunCardState(), {
      type: "native_tool_started",
      toolName: "mcp__database__query",
      callId: "c2",
    });
    expect(state.activeTool?.label).toBe("正在调用 database · query");
    expect(JSON.stringify(state)).not.toContain("SELECT");
  });

  test("product tools never enter the process strip — dedicated events own them", () => {
    const started = applyRunEvent(initialRunCardState(), {
      type: "native_tool_started",
      toolName: "todo_write",
      callId: "c3",
    });
    expect(started.activeTool).toBeNull();
    const completed = applyRunEvent(started, {
      type: "native_tool_completed",
      toolName: "todo_write",
      callId: "c3",
      result: { items: [] },
    });
    expect(completed.completedTools).toEqual([]);
    // ask_question is answered by the question frame instead.
    expect(
      applyRunEvent(initialRunCardState(), {
        type: "native_tool_started",
        toolName: "ask_question",
        callId: "c4",
      }).activeTool,
    ).toBeNull();
  });
});
