/**
 * Ask Feishu whether every card shape this bot can render is legal.
 *
 * Why this exists: three separate wire-level rules rejected whole cards in
 * production before anyone saw them (300123 form needs a submit button,
 * 300301 element_id format, 300313 element must exist) and each rejection
 * cost a live run. Unit tests cannot see those rules - they live in the
 * platform's validator - so this probe renders the REAL cards through the
 * REAL renderer and posts each one to the card API.
 *
 *   bun apps/lark-bot/scripts/probe-cards.ts <lark-profile>
 *
 * Silent: it creates card entities, it never sends a message to a chat.
 * Cost: a handful of card-entity bindings per run (the app has a quota), so
 * run it after touching the renderer, not on every commit. The platform
 * exposes no delete endpoint, hence the card entities stay behind.
 */
import { createTokenProvider } from "../src/lark-api.js";
import { renderCard } from "../src/run-card/card-renderer.js";
import {
  applyRunEvent,
  initialRunCardState,
  type RunCardState,
} from "../src/run-card/card-state.js";

const profile = process.argv[2];
if (!profile) {
  console.error("usage: bun apps/lark-bot/scripts/probe-cards.ts <lark-profile>");
  process.exit(2);
}

function readCode(body: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("code" in parsed)) return null;
  const code = parsed.code;
  return typeof code === "number" ? code : null;
}

function ask(kind: string, allowOther: boolean): RunCardState {
  return applyRunEvent(initialRunCardState(), {
    type: "backend.oma.ask_requested",
    payload: {
      callId: "probe-call",
      questions: [
        {
          id: "probe-q",
          kind,
          question: "plan.md 放在哪里？",
          allowOther,
          options: [
            { label: "tmp/plan.md（当前工作区）", value: "tmp/plan.md" },
            { label: "docs/plan.md（文档目录）", value: "docs/plan.md" },
          ],
        },
      ],
    },
  } as never);
}

const plan = [
  { id: "1", text: "读需求", status: "done" },
  { id: "2", text: "写 plan.md", status: "in_progress" },
  { id: "3", text: "执行", status: "pending" },
  { id: "4", text: "收尾", status: "pending" },
  { id: "5", text: "归档", status: "pending" },
];

let running = applyRunEvent(initialRunCardState(), { type: "text_delta", text: "先看结构。" });
running = applyRunEvent(running, {
  type: "backend.oma.todo_update",
  payload: { items: plan },
} as never);
running = applyRunEvent(running, {
  type: "native_tool_started",
  toolName: "bash",
  callId: "t1",
  activity: "运行命令：ls",
} as never);
running = applyRunEvent(running, {
  type: "native_tool_completed",
  toolName: "bash",
  callId: "t1",
} as never);

const withTodos = ask("select", true);
const cases: Array<{ label: string; state: RunCardState }> = [
  { label: "run card (todos + tool)", state: running },
  {
    label: "terminal run card",
    state: applyRunEvent(running, { type: "status", status: "completed" }),
  },
  {
    label: "ask card (select + todos)",
    state: applyRunEvent(withTodos, {
      type: "backend.oma.todo_update",
      payload: { items: plan },
    } as never),
  },
  { label: "ask card (select)", state: withTodos },
  { label: "ask card (text)", state: ask("text", true) },
  {
    label: "approval card",
    state: applyRunEvent(initialRunCardState(), {
      type: "backend.oma.approval_request",
      payload: { callId: "probe-call" },
    } as never),
  },
];

const tokenProvider = createTokenProvider(profile);
const token = await tokenProvider.getToken();
const base = tokenProvider.getBaseUrl();
const meta = { runId: "probe-run", startedAt: Date.now(), webUrl: "http://web/runs/probe" };

let failed = 0;
for (const { label, state } of cases) {
  const res = await fetch(`${base}/open-apis/cardkit/v1/cards`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      type: "card_json",
      data: JSON.stringify(renderCard(state, meta)),
    }),
  });
  const body = await res.text();
  const code = readCode(body);
  if (code === 0) {
    console.log(`OK    ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label} -> http ${res.status} ${body.slice(0, 220)}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} card shape(s) rejected by Feishu - fix before shipping.`);
  process.exit(1);
}
console.log(`\n${cases.length} card shapes accepted.`);
