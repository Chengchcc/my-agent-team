import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  getRunCard,
  insertInputCard,
  insertRunCard,
  listActiveRunCards,
  listNonTerminalRunCards,
  openBindings,
  runCardOwnsDelivery,
  runIdFromMessageId,
  updateInputCard,
  updateRunCard,
} from "../bindings-sqlite.js";
import { handleCardActionLine } from "./card-actions.js";
import { createCardFlushController } from "./card-flush.js";
import { renderCard, renderRunCard } from "./card-renderer.js";
import {
  applyRunEvent,
  initialRunCardState,
  pendingActionFromBackend,
  toolActivity,
} from "./card-state.js";
import { createCardUpdater } from "./card-updater.js";
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
  test("the tool line prefers the structured presentation", () => {
    // The presentation is the tool's own account of the call; the activity
    // string is the legacy fallback. A surface must never prefer the
    // fallback when the structured form is present.
    let s = initialRunCardState();
    s = applyRunEvent(s, {
      type: "native_tool_started",
      toolName: "bash",
      callId: "c1",
      activity: "运行命令：ls",
      presentation: { title: "运行命令", detail: "ls -la" },
    });
    expect(s.activeTool?.label).toBe("运行命令：ls -la");

    s = applyRunEvent(s, {
      type: "native_tool_completed",
      toolName: "grep",
      callId: "c2",
      activity: "搜索代码：TODO",
      presentation: { title: "搜索代码", resultSummary: "命中 6 处，涉及 3 个文件" },
    });
    expect(s.completedTools.at(-1)?.label).toBe("搜索代码：命中 6 处，涉及 3 个文件");
  });

  test("pendingActionFromBackend reproduces the live event reduction", () => {
    // Restart recovery rebuilds the card's pending action from the backend's
    // durable record; a restored card must be indistinguishable from a live
    // one, or buttons appear with different payloads than the resolve path
    // expects.
    const approvalLive = applyRunEvent(initialRunCardState(), {
      type: "backend.oma.approval_request",
      payload: { callId: "c1" },
    });
    expect(pendingActionFromBackend("approval", { callId: "c1" })).toEqual(
      approvalLive.pendingAction,
    );

    const questions = [
      {
        id: "q1",
        question: "选一项",
        kind: "select",
        allowOther: false,
        options: [
          { label: "甲", value: "a" },
          { label: "乙", value: "b" },
        ],
      },
    ];
    const askLive = applyRunEvent(initialRunCardState(), {
      type: "backend.oma.ask_requested",
      payload: { callId: "c2", questions },
    });
    expect(pendingActionFromBackend("ask", { callId: "c2", questions })).toEqual(
      askLive.pendingAction,
    );
  });

  test("pendingActionFromBackend rejects malformed records", () => {
    expect(pendingActionFromBackend("unknown-kind", {})).toBeNull();
    expect(pendingActionFromBackend("approval", {})).toBeNull(); // no callId
    expect(pendingActionFromBackend("ask", { callId: "c" })).toBeNull(); // no questions
  });

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
    // The panel carries a count header and the plan lines; the active item
    // is bold, done/pending keep their plain symbols. Cancelled items stay
    // out of a LIVE plan (they appear on the terminal card).
    expect(content).toContain("进度 1 / 4");
    expect(content).toContain("✓ 读代码");
    expect(content).toContain("● **改代码**");
    expect(content).toContain("○ 待办");
    expect(content).toContain("collapsible_panel");
    expect(content).not.toContain("✗ 别做");
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
        cancelQueuedInput: async (inputId: string) => {
          calls.push(`cancelInput:${inputId}`);
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
          freeText?: string;
        }) => {
          calls.push(
            `ask:${input.runId}:${input.callId}:${input.questionId}:${input.selectedValue}:${input.freeText ?? ""}`,
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
    expect(calls).toEqual(["ask:run-ask:call-ask:q1:main:"]);
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
  test("cancel_input cancels the INPUT and never the running turn", async () => {
    // A waiting message has no run card to compare against, so it is validated
    // against its own record: the callback's message must be the one carrying
    // that input's queued card.
    insertInputCard(db, {
      inputId: "in_q",
      conversationId: "conv-q",
      larkChatId: "oc_actions",
      now: Date.now(),
    });
    updateInputCard(db, "in_q", { larkMessageId: "om_queued_card", cardKitId: "card_q" });
    const h = deps();
    const cancelled = await handleCardActionLine(
      callbackLine({
        event_id: "ev-cancel-input",
        operator_id: "ou_user",
        chat_id: "oc_actions",
        message_id: "om_queued_card",
        action_tag: "button",
        action_value: JSON.stringify({ action: "cancel_input", inputId: "in_q" }),
      }),
      h.deps,
    );
    expect(cancelled).toBe("input-cancelled");
    // The INPUT is cancelled: no run was touched.
    expect(h.calls).toEqual(["cancelInput:in_q"]);

    const forged = await handleCardActionLine(
      callbackLine({
        event_id: "ev-cancel-forged",
        operator_id: "ou_user",
        chat_id: "oc_actions",
        message_id: "om_not_our_card",
        action_tag: "button",
        action_value: JSON.stringify({ action: "cancel_input", inputId: "in_q" }),
      }),
      h.deps,
    );
    expect(forged).toBe("rejected");
    expect(h.calls).toEqual(["cancelInput:in_q"]);
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
    // The wire name is MCP-qualified (backend workspace-bridge):
    // `mcp__product-tools__todo_write`. A bare-name check passes this test
    // while the real event still renders "正在调用 product-tools · todo_write"
    // — so both forms are asserted, and the qualified one is the real wire.
    for (const toolName of ["mcp__product-tools__todo_write", "todo_write"]) {
      const started = applyRunEvent(initialRunCardState(), {
        type: "native_tool_started",
        toolName,
        callId: "c3",
      });
      expect(started.activeTool).toBeNull();
      const completed = applyRunEvent(started, {
        type: "native_tool_completed",
        toolName,
        callId: "c3",
        result: { items: [] },
      });
      expect(completed.completedTools).toEqual([]);
    }
    // ask_question is answered by the question frame instead.
    for (const toolName of ["mcp__product-tools__ask_question", "ask_question"]) {
      expect(
        applyRunEvent(initialRunCardState(), {
          type: "native_tool_started",
          toolName,
          callId: "c4",
        }).activeTool,
      ).toBeNull();
    }
  });
});

describe("dedicated ask / approval card", () => {
  const meta = { runId: "r1", startedAt: Date.now(), webUrl: "http://web/runs/r1" };

  test("a parked ask replaces the run card with an orange form card", () => {
    let s = initialRunCardState();
    s = applyRunEvent(s, { type: "text_delta", text: "正在处理。" });
    s = applyRunEvent(s, {
      type: "backend.oma.ask_requested",
      payload: {
        callId: "c1",
        questions: [
          {
            id: "q1",
            kind: "select",
            question: "要修改哪个分支？",
            options: [
              { label: "main", value: "main" },
              { label: "release/2026.09", value: "release" },
            ],
          },
        ],
      },
    });
    const card = renderCard(s, meta) as {
      header: { title: { content: string }; template: string };
      body: { elements: Array<{ tag: string; content?: string }> };
    };
    expect(card.header.title.content).toBe("需要你的回答");
    expect(card.header.template).toBe("orange");
    const flat = JSON.stringify(card);
    expect(flat).toContain("要修改哪个分支？");
    expect(flat).toContain("answer_ask");
    // The plan's container rule: the todo panel is a collapsible_panel and
    // must never share a card with an interactive form area.
    expect(card.body.elements.some((e) => e.tag === "collapsible_panel")).toBe(false);
    // …and the run card's streaming controls are gone.
    expect(flat).not.toContain("stop_button");
  });

  test("an approval keeps approve/reject and names the frame", () => {
    let s = initialRunCardState();
    s = applyRunEvent(s, {
      type: "backend.oma.approval_request",
      payload: { callId: "c2" },
    });
    const card = renderCard(s, meta) as {
      header: { title: { content: string } };
    };
    const flat = JSON.stringify(card);
    expect(card.header.title.content).toBe("需要确认");
    expect(flat).toContain("批准");
    expect(flat).toContain("拒绝");
  });

  test("the running frame is the run card again once the ask clears", () => {
    let s = initialRunCardState();
    s = applyRunEvent(s, {
      type: "backend.oma.ask_requested",
      payload: { callId: "c3", questions: [] },
    });
    s = applyRunEvent(s, { type: "text_delta", text: "继续" });
    const card = renderCard(s, meta) as { header: { title: { content: string } } };
    expect(card.header.title.content).not.toBe("需要你的回答");
  });
});

describe("free-text ask form", () => {
  function seedFormCard(runId: string, messageId: string): void {
    insertRunCard(db, {
      runId,
      conversationId: `conv-${runId}`,
      larkChatId: "oc_actions",
      sourceMessageId: "om_src",
    });
    updateRunCard(db, runId, { status: "streaming", larkMessageId: messageId });
  }

  function formDeps() {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        db,
        cancelRun: async () => ({}),
        cancelQueuedInput: async () => ({}),
        resolveApproval: async () => ({}),
        resolveAsk: async (input: {
          runId: string;
          callId: string;
          questionId: string;
          selectedValue: string;
          freeText?: string;
        }) => {
          calls.push(
            `ask:${input.runId}:${input.callId}:${input.questionId}:${input.selectedValue}:${input.freeText ?? ""}`,
          );
          return {};
        },
        log: () => {},
      },
    };
  }

  test("a text ask renders a root-level form with an input and a submit", () => {
    const meta = { runId: "r1", startedAt: Date.now(), webUrl: null };
    let s = initialRunCardState();
    s = applyRunEvent(s, {
      type: "backend.oma.ask_requested",
      payload: {
        callId: "c1",
        questions: [{ id: "q1", kind: "text", question: "要改哪个分支？" }],
      },
    });
    const card = renderCard(s, meta) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    const form = card.body.elements.find((e) => e.tag === "form") as
      | { name: string; elements: Array<Record<string, unknown>> }
      | undefined;
    expect(form).toBeDefined();
    expect(form!.elements.some((e) => e.tag === "input" && e.name === "answer")).toBe(true);
    const submit = form!.elements.find((e) => e.tag === "button") as {
      form_action_type: string;
      name: string;
      value: Record<string, unknown>;
    };
    expect(submit.form_action_type).toBe("submit");
    expect(submit.name).toBe("ask_submit");
    // Identity travels in the button value (200340 also requires it to exist).
    expect(submit.value).toEqual({
      runId: "r1",
      callId: "c1",
      questionId: "q1",
      action: "answer_ask",
    });
  });

  test("a select ask keeps callback buttons instead of a form", () => {
    const meta = { runId: "r1", startedAt: Date.now(), webUrl: null };
    let s = initialRunCardState();
    s = applyRunEvent(s, {
      type: "backend.oma.ask_requested",
      payload: {
        callId: "c1",
        questions: [
          {
            id: "q1",
            kind: "select",
            question: "哪个？",
            options: [{ label: "main", value: "main" }],
          },
        ],
      },
    });
    const flat = JSON.stringify(renderCard(s, meta));
    expect(flat).not.toContain('"tag":"form"');
    expect(flat).toContain("answer_ask");
  });

  test("a form submit resolves the ask with the typed text", async () => {
    seedFormCard("run-form", "om_form");
    const { calls, deps: d } = formDeps();
    const line = JSON.stringify({
      event_id: "ev-form",
      operator_id: "ou_1",
      chat_id: "oc_actions",
      message_id: "om_form",
      action_tag: "form_submit",
      action_name: "ask_submit",
      action_value: JSON.stringify({
        runId: "run-form",
        callId: "call-form",
        questionId: "q-form",
        action: "answer_ask",
      }),
      form_value: { answer: "用 release 分支" },
    });
    expect(await handleCardActionLine(line, d)).toBe("answered");
    expect(calls).toEqual(["ask:run-form:call-form:q-form::用 release 分支"]);
  });

  test("a form submit without identity is logged, not guessed", async () => {
    const { calls, deps: d } = formDeps();
    const line = JSON.stringify({
      event_id: "ev-form-2",
      operator_id: "ou_1",
      chat_id: "oc_actions",
      message_id: "om_form",
      action_tag: "form_submit",
      action_name: "ask_submit",
      form_value: { answer: "hi" },
    });
    expect(await handleCardActionLine(line, d)).toBe("unparsed-form");
    expect(calls).toEqual([]);
  });
});

describe("card updater degradation", () => {
  test("three consecutive CardKit failures stop live painting", async () => {
    insertRunCard(db, {
      runId: "run-deg",
      conversationId: "conv-deg",
      larkChatId: "oc_deg",
      sourceMessageId: "om_src_deg",
    });
    updateRunCard(db, "run-deg", { status: "streaming", cardKitId: "card-deg" });
    let calls = 0;
    const failingClient = {
      updateCard: async () => {
        calls += 1;
        return { ok: false, error: "boom" };
      },
      streamElement: async () => {
        calls += 1;
        return { ok: false, error: "boom" };
      },
      closeStreaming: async () => ({ ok: true }),
    } as never;
    const state = initialRunCardState();
    const updater = createCardUpdater({
      cardClient: failingClient,
      db,
      runId: "run-deg",
      meta: { runId: "run-deg", startedAt: Date.now(), webUrl: null },
      getState: () => state,
      getCardId: () => "card-deg",
      nextSeq: () => 1,
      onPersist: () => {},
      retryBackoffMs: 1,
    });

    // Three exhausted replaces (each retries internally) cross the threshold.
    await updater.replaceNow(state);
    await updater.replaceNow(state);
    await updater.replaceNow(state);
    expect(calls).toBeGreaterThan(0);
    expect(getRunCard(db, "run-deg")?.degraded).toBe(true);
    const before = calls;
    await updater.replaceNow(state);
    expect(calls).toBe(before); // degraded: no further CardKit calls
    expect(getRunCard(db, "run-deg")?.lastError).toBeTruthy();
  });

  test("a question frame still gets one attempt after degrading", async () => {
    // Own bindings db: the shared `db` is assigned inside another test's body,
    // so this case would break when run alone or under a name filter.
    const askDir = `/tmp/test-lark-run-card-ask-${Date.now()}`;
    const askDb = openBindings("test-ask-deg", askDir);
    try {
      insertRunCard(askDb, {
        runId: "run-ask-deg",
        conversationId: "conv-ask-deg",
        larkChatId: "oc_ask_deg",
        sourceMessageId: "om_src_ask_deg",
      });
      updateRunCard(askDb, "run-ask-deg", { status: "streaming", cardKitId: "card-ask-deg" });
      let calls = 0;
      let healthy = false;
      const client = {
        updateCard: async () => {
          calls += 1;
          return healthy ? { ok: true, seq: calls } : { ok: false, error: "boom" };
        },
        streamElement: async () => ({ ok: false, error: "boom" }),
        closeStreaming: async () => ({ ok: true }),
      } as never;
      let state = initialRunCardState();
      const updater = createCardUpdater({
        cardClient: client,
        db: askDb,
        runId: "run-ask-deg",
        meta: { runId: "run-ask-deg", startedAt: Date.now(), webUrl: null },
        getState: () => state,
        getCardId: () => "card-ask-deg",
        nextSeq: () => 1,
        onPersist: () => {},
        retryBackoffMs: 1,
      });
      for (let i = 0; i < 3; i++) await updater.replaceNow(state);
      expect(getRunCard(askDb, "run-ask-deg")?.degraded).toBe(true);

      // A question is the one frame the human must see (buttons, form). While
      // the card is degraded it is attempted once, then left alone: a broken
      // card must not become an unanswerable question.
      state = applyRunEvent(state, {
        type: "backend.oma.ask_requested",
        payload: {
          callId: "c",
          questions: [
            { id: "q", kind: "select", question: "哪？", options: [{ label: "a", value: "a" }] },
          ],
        },
      });
      const afterDegrade = calls;
      expect(await updater.replaceNow(state)).toBe(false);
      expect(calls).toBeGreaterThan(afterDegrade);
      expect(getRunCard(askDb, "run-ask-deg")?.degraded).toBe(true);
      const afterAsk = calls;
      await updater.replaceNow(state);
      expect(calls).toBe(afterAsk); // once per question, not per flush

      // And when CardKit is healthy again, the attempt revives the card.
      healthy = true;
      const nextQuestion = applyRunEvent(initialRunCardState(), {
        type: "backend.oma.ask_requested",
        payload: {
          callId: "c2",
          questions: [
            {
              id: "q2",
              kind: "select",
              question: "第二个问题？",
              options: [{ label: "a", value: "a" }],
            },
          ],
        },
      });
      expect(await updater.replaceNow(nextQuestion)).toBe(true);
      expect(getRunCard(askDb, "run-ask-deg")?.degraded).toBe(false);
    } finally {
      askDb.close();
    }
  });

  test("the flush path also lets a pending question through while degraded", async () => {
    const dir = `/tmp/test-lark-run-card-flush-${Date.now()}`;
    const flushDb = openBindings("test-flush-deg", dir);
    try {
      insertRunCard(flushDb, {
        runId: "run-flush-deg",
        conversationId: "conv-flush-deg",
        larkChatId: "oc_flush_deg",
        sourceMessageId: "om_src_flush_deg",
      });
      updateRunCard(flushDb, "run-flush-deg", { status: "streaming", cardKitId: "card-flush-deg" });
      let healthy = false;
      const client = {
        updateCard: async () => (healthy ? { ok: true, seq: 1 } : { ok: false, error: "boom" }),
        streamElement: async () => ({ ok: false, error: "boom" }),
        closeStreaming: async () => ({ ok: true }),
      } as never;
      let state = initialRunCardState();
      const updater = createCardUpdater({
        cardClient: client,
        db: flushDb,
        runId: "run-flush-deg",
        meta: { runId: "run-flush-deg", startedAt: Date.now(), webUrl: null },
        getState: () => state,
        getCardId: () => "card-flush-deg",
        nextSeq: () => 1,
        onPersist: () => {},
        retryBackoffMs: 1,
      });
      for (let i = 0; i < 3; i++) await updater.replaceNow(state);
      expect(getRunCard(flushDb, "run-flush-deg")?.degraded).toBe(true);

      state = applyRunEvent(state, {
        type: "backend.oma.ask_requested",
        payload: {
          callId: "c-flush",
          questions: [{ id: "q", kind: "text", question: "说说？" }],
        },
      });
      // The flush's own degraded guard used to swallow this frame, so a
      // question raised after the card gave up was never painted.
      healthy = true;
      updater.request();
      await updater.finish();
      expect(getRunCard(flushDb, "run-flush-deg")?.degraded).toBe(false);
      expect(getRunCard(flushDb, "run-flush-deg")?.lastError).toBeTruthy();
    } finally {
      flushDb.close();
    }
  });
});

describe("run card element set", () => {
  test("activity/output/tools/status are always present, even when empty", () => {
    // CardKit's element update needs the target element to EXIST. Omitting an
    // empty one made the first tool completion fail with 300313 (not find
    // elementID: tool_summary) and, after three strikes, degraded the card.
    const card = renderRunCard(initialRunCardState(), {
      runId: "r1",
      startedAt: Date.now(),
      webUrl: null,
    }) as { body: { elements: Array<{ element_id?: string }> } };
    const ids = card.body.elements.map((e) => e.element_id).filter(Boolean);
    expect(ids).toEqual(
      expect.arrayContaining(["activity_md", "agent_output", "tool_summary", "run_status"]),
    );
  });
});

describe("element id legality (Feishu 300301)", () => {
  /** Every element_id anywhere in a card body: ASCII, starts with a letter,
   *  ≤20 chars. Deriving an id from content (an option's value) violated this
   *  on the first Chinese/path label and the rejected card degraded. */
  function collectIds(node: unknown, out: string[]): void {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) collectIds(item, out);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "element_id" && typeof value === "string") out.push(value);
      else collectIds(value, out);
    }
  }

  test("every rendered card keeps its element ids legal", () => {
    const legal = /^[a-zA-Z][a-zA-Z0-9_]{0,19}$/;
    const meta = { runId: "r1", startedAt: Date.now(), webUrl: "http://web/r1" };
    const longLabelOptions = [
      { label: "tmp/plan.md（当前工作区）", value: "tmp/plan.md（当前工作区）" },
      { label: "docs/plan.md（仓库文档目录）", value: "docs/plan.md（仓库文档目录）" },
    ];
    const states: RunCardState[] = [];
    let base = initialRunCardState();
    base = applyRunEvent(base, { type: "text_delta", text: "working" });
    base = applyRunEvent(base, {
      type: "native_tool_started",
      toolName: "bash",
      callId: "c1",
      activity: "运行命令：ls",
    });
    base = applyRunEvent(base, {
      type: "backend.oma.todo_update",
      payload: {
        items: [
          { id: "1", text: "一步", status: "done" },
          { id: "2", text: "二步", status: "in_progress" },
        ],
      },
    });
    states.push(base);
    let selectAsk = initialRunCardState();
    selectAsk = applyRunEvent(selectAsk, {
      type: "backend.oma.ask_requested",
      payload: {
        callId: "c",
        questions: [{ id: "q", kind: "select", question: "哪？", options: longLabelOptions }],
      },
    });
    states.push(selectAsk);
    let textAsk = initialRunCardState();
    textAsk = applyRunEvent(textAsk, {
      type: "backend.oma.ask_requested",
      payload: { callId: "c", questions: [{ id: "q", kind: "text", question: "说说？" }] },
    });
    states.push(textAsk);
    let approval = initialRunCardState();
    approval = applyRunEvent(approval, {
      type: "backend.oma.approval_request",
      payload: { callId: "c" },
    });
    states.push(approval);
    const terminal = applyRunEvent(base, { type: "status", status: "completed" });
    states.push(terminal);

    for (const state of states) {
      const ids: string[] = [];
      collectIds(renderCard(state, meta), ids);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(id).toMatch(legal);
      }
    }
  });
});
