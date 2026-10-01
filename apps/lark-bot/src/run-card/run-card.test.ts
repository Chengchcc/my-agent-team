import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import type { ChatState } from "@microsoft/agent-host-protocol";
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
  cardStateFromChatTurn,
  initialRunCardState,
  pendingActionFromBackend,
  toolActivity,
} from "./card-state.js";
import { createCardUpdater } from "./card-updater.js";
import { fetchPendingActions, finalAnswerText } from "./run-card-watcher.js";

const testDir = `/tmp/test-lark-run-card-${Date.now()}`;
let db: Database;

afterAll(() => {
  db?.close();
});

/** A card state built out of the parts a run produces - the reader's own vocabulary, so a test
 *  and production cannot describe the same card two different ways. */
function cardStateOf(spec: {
  output?: string;
  tools?: ReadonlyArray<{ toolName: string; activity?: string; status?: string }>;
  ask?: { callId: string; questions: readonly unknown[] };
  approval?: { callId: string; toolName?: string; input?: unknown };
  todos?: readonly unknown[];
  settled?: "complete" | "error" | "cancelled";
  error?: string;
}): RunCardState {
  const parts: Record<string, unknown>[] = [];
  if (spec.output !== undefined) parts.push({ kind: "markdown", id: "t0", content: spec.output });
  for (const tool of spec.tools ?? []) {
    parts.push({
      kind: "toolCall",
      toolCall: {
        toolCallId: `${tool.toolName}-c`,
        toolName: tool.toolName,
        displayName: tool.toolName,
        status: tool.status ?? "completed",
        success: true,
        ...(tool.activity === undefined ? {} : { intention: tool.activity }),
      },
    });
  }
  const request = spec.ask
    ? {
        id: "run-1:call",
        message: "ask",
        _meta: {
          productRequest: { callId: spec.ask.callId, questions: spec.ask.questions },
        },
      }
    : spec.approval === undefined
      ? undefined
      : {
          id: "run-1:call",
          message: "approval",
          _meta: { productRequest: { ...spec.approval } },
        };
  if (request) parts.push({ kind: "inputRequest", request });
  if (spec.error !== undefined) {
    parts.push({ kind: "error", error: { errorType: "run_failed", message: spec.error } });
  }

  const turn = {
    id: "run-1",
    startedAt: new Date(0).toISOString(),
    message: { text: "go", origin: { kind: "user" } },
    responseParts: parts,
    usage: undefined,
    ...(spec.settled === undefined ? {} : { state: spec.settled }),
  };
  const chat = {
    resource: "ahp-chat:/c1",
    title: "t",
    status: 1,
    modifiedAt: new Date(0).toISOString(),
    turns: spec.settled === undefined ? [] : [turn],
    ...(spec.settled === undefined ? { activeTurn: turn } : {}),
    ...(spec.todos === undefined ? {} : { _meta: { todos: spec.todos } }),
  } as ChatState;
  const card = cardStateFromChatTurn(chat, "run-1");
  if (card === undefined) throw new Error("fixture produced no card state");
  return card;
}

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
    const state = cardStateOf({ settled: "complete" });
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

    const failed = cardStateOf({ settled: "error", error: "boom" });
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
    const state = cardStateOf({
      tools: [{ toolName: "bash", activity: "正在执行：bun test apps/backend", status: "running" }],
    });
    expect(state.activeTool?.label).toBe("正在执行：bun test apps/backend");
    const content = JSON.stringify(
      renderRunCard(state, { runId: "r1", startedAt: Date.now(), webUrl: null }),
    );
    expect(content).toContain("正在执行：bun test apps/backend");
  });

  test("a tool without activity degrades to its name, not a guessed summary", () => {
    const state = cardStateOf({ tools: [{ toolName: "mcp__database__query", status: "running" }] });
    expect(state.activeTool?.label).toBe("正在调用 database · query");
    expect(JSON.stringify(state)).not.toContain("SELECT");
  });

  test("product tools never enter the process strip — dedicated events own them", () => {
    // The wire name is MCP-qualified (backend workspace-bridge):
    // `mcp__product-tools__todo_write`. A bare-name check passes this test
    // while the real event still renders "正在调用 product-tools · todo_write"
    // — so both forms are asserted, and the qualified one is the real wire.
    for (const toolName of ["mcp__product-tools__todo_write", "todo_write"]) {
      const started = cardStateOf({ tools: [{ toolName, status: "running" }] });
      expect(started.activeTool).toBeNull();
      const completed = cardStateOf({ tools: [{ toolName, status: "completed" }] });
      expect(completed.completedTools).toEqual([]);
    }
    // ask_question is answered by the question frame instead.
    for (const toolName of ["mcp__product-tools__ask_question", "ask_question"]) {
      expect(cardStateOf({ tools: [{ toolName, status: "running" }] }).activeTool).toBeNull();
    }
  });
});

describe("dedicated ask / approval card", () => {
  const meta = { runId: "r1", startedAt: Date.now(), webUrl: "http://web/runs/r1" };

  test("a parked ask replaces the run card with an orange form card", () => {
    const s = cardStateOf({
      output: "正在处理。",
      ask: {
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
    // …and the run card's streaming controls are gone.
    expect(flat).not.toContain("stop_button");
  });

  test("an approval keeps approve/reject and names the frame", () => {
    const s = cardStateOf({ approval: { callId: "c2" } });
    const card = renderCard(s, meta) as {
      header: { title: { content: string } };
    };
    const flat = JSON.stringify(card);
    // No toolName in the payload: the header stays bare rather than naming a
    // tool nobody told us about.
    expect(card.header.title.content).toBe("需要确认");
    expect(flat).toContain("批准执行");
    expect(flat).toContain("拒绝");
    // …and with a tool name it names the ACTION, not the binary.
    const named = renderCard(
      cardStateOf({ approval: { callId: "c3", toolName: "bash" } }),
      meta,
    ) as { header: { title: { content: string } } };
    expect(named.header.title.content).toBe("需要确认：执行命令");
  });

  test("the running frame is the run card again once the ask clears", () => {
    // While the question is open the card IS the ask frame…
    const asking = renderCard(
      cardStateOf({
        ask: {
          callId: "c3",
          questions: [
            { id: "q1", kind: "select", question: "哪？", options: [{ label: "a", value: "a" }] },
          ],
        },
      }),
      meta,
    ) as { header: { title: { content: string } } };
    expect(asking.header.title.content).toBe("需要你的回答");
    // …and the run frame again once the channel stops carrying it (the reader drops an answered
    // request, so the buttons cannot outlive the question).
    const running = renderCard(cardStateOf({ output: "继续" }), meta) as {
      header: { title: { content: string } };
    };
    expect(running.header.title.content).not.toBe("需要你的回答");
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
    const s = cardStateOf({
      ask: {
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

  test("a select ask renders one label+button row per option", () => {
    const meta = { runId: "r1", startedAt: Date.now(), webUrl: null };
    const s = cardStateOf({
      ask: {
        callId: "c1",
        questions: [
          {
            id: "q1",
            kind: "select",
            question: "哪个？",
            options: [
              { label: "main", value: "main", description: "默认分支，改动最显眼" },
              { label: "release/2026.09 的长期维护分支", value: "release" },
            ],
          },
        ],
      },
    });
    const card = renderCard(s, meta) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    // The model's per-option helper line has to survive parsing; it was being
    // dropped (AskOption had no description field).
    expect(JSON.stringify(card)).toContain("默认分支，改动最显眼");
    // Not a form: a form must contain a submit button (Feishu 300123), and
    // these options answer in one click.
    expect(card.body.elements.some((e) => e.tag === "form")).toBe(false);
    const rows = card.body.elements.filter((e) => e.tag === "column_set") as Array<{
      columns: Array<{ elements: Array<Record<string, unknown>> }>;
    }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // Label left, button right: the buttons carry the same text, so the
      // rows line up. No width:"fill" - a live card rejected the click with it.
      const label = JSON.stringify(row.columns[0]?.elements ?? []);
      expect(label).toMatch(/main|release/);
      const button = row.columns[1]?.elements?.[0] as Record<string, unknown>;
      expect(button.tag).toBe("button");
      expect(button.width).toBeUndefined();
    }
    expect(JSON.stringify(rows)).toContain("answer_ask");
  });

  test("a question keeps the progress panel on the card", () => {
    const meta = { runId: "r1", startedAt: Date.now(), webUrl: null };
    const s = cardStateOf({
      todos: [
        { id: "1", text: "读需求", status: "done" },
        { id: "2", text: "写 plan.md", status: "in_progress" },
      ],
      ask: {
        callId: "c1",
        questions: [
          { id: "q1", kind: "select", question: "放哪？", options: [{ label: "a", value: "a" }] },
        ],
      },
    });
    const card = renderCard(s, meta) as {
      body: { elements: Array<{ tag: string; content?: string }> };
    };
    // The ask used to drop the plan, so the question arrived with no context.
    const progress = card.body.elements.find((e) => e.content?.includes("进度 1 / 2"));
    expect(progress?.content).toContain("● **写 plan.md**");
    // …as flat markdown, never a container: a container plus interactive
    // elements is what broke the click on a live card.
    expect(card.body.elements.some((e) => e.tag === "collapsible_panel")).toBe(false);
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

describe("card restore reads the durable action where it really lives", () => {
  test("fetchPendingActions parses the run-nested payload (GET /api/agent-runs/:id)", async () => {
    // The live shape: { run: { …, pendingActions: [...] }, inputs: [...] }.
    // Reading it at the top level (the old bug) found nothing, so a card
    // restored after a bot restart came back WITHOUT its approval buttons.
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          run: {
            runId: "r-nested",
            status: "waiting",
            pendingActions: [
              { kind: "resolved-one", status: "resolved", payload: {} },
              {
                kind: "approval",
                status: "pending",
                payload: {
                  callId: "c-nested",
                  toolName: "bash",
                  reason: "permission",
                  input: { command: "echo nested-ok" },
                },
              },
            ],
          },
          inputs: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    try {
      const action = await fetchPendingActions("http://backend.test", "tok", "r-nested");
      expect(calls).toEqual(["http://backend.test/api/agent-runs/r-nested"]);
      expect(action?.kind).toBe("approval");
      expect(action?.callId).toBe("c-nested");
      expect(action?.prompt).toContain("echo nested-ok");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("fetchPendingActions returns null when nothing is pending", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ run: { pendingActions: [] }, inputs: [] }), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      expect(await fetchPendingActions("http://backend.test", null, "r-none")).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
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
      state = {
        ...state,
        ...cardStateOf({
          ask: {
            callId: "c",
            questions: [
              { id: "q", kind: "select", question: "哪？", options: [{ label: "a", value: "a" }] },
            ],
          },
        }),
      };
      const afterDegrade = calls;
      expect(await updater.replaceNow(state)).toBe(false);
      expect(calls).toBeGreaterThan(afterDegrade);
      expect(getRunCard(askDb, "run-ask-deg")?.degraded).toBe(true);
      const afterAsk = calls;
      await updater.replaceNow(state);
      expect(calls).toBe(afterAsk); // once per question, not per flush

      // And when CardKit is healthy again, the attempt revives the card.
      healthy = true;
      const nextQuestion = cardStateOf({
        ask: {
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

      // A state that now carries a question (the same shape a live frame has).
      state = {
        ...state,
        ...cardStateOf({
          ask: { callId: "c-flush", questions: [{ id: "q", kind: "text", question: "说说？" }] },
        }),
      };
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
    const base: RunCardState = {
      ...initialRunCardState(),
      phase: "tool_running",
      output: "working",
      activeTool: { label: toolActivity("运行命令：ls", "bash"), startedAt: Date.now() },
      todos: [
        { id: "1", text: "一步", status: "done" },
        { id: "2", text: "二步", status: "in_progress" },
      ],
    };
    states.push(base);
    const askState = (question: unknown): RunCardState | null => {
      const pending = pendingActionFromBackend("ask", { callId: "c", questions: [question] });
      return pending ? { ...initialRunCardState(), pendingAction: pending, waiting: "ask" } : null;
    };
    const select = askState({
      id: "q",
      kind: "select",
      question: "哪？",
      options: longLabelOptions,
    });
    const text = askState({ id: "q", kind: "text", question: "说说？" });
    const approval = pendingActionFromBackend("approval", { callId: "c" });
    if (!select || !text || !approval) throw new Error("fixture did not build a pending action");
    states.push(select, text, {
      ...initialRunCardState(),
      pendingAction: approval,
      waiting: "approval",
    });
    states.push({ ...base, terminal: { status: "completed", error: null } });

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
