import { describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { buildAgentConfig } from "../agent/agent-config.js";
import type { AgentRow } from "../agent/domain.js";
import { sqliteProactiveAdapter } from "./adapter-sqlite.js";
import { createProactiveService } from "./service.js";

function agentRowWithRules(
  rules: Array<{
    id: string;
    keyword: string;
    mode?: "record" | "act";
    instruction?: string;
    chats?: string[];
    senders?: string[];
  }>,
): AgentRow {
  const config = buildAgentConfig({
    id: "ag1",
    name: "ag1",
    harness: "oma",
    lark: {
      enabled: true,
      ambientRules: rules.map((r) => ({
        id: r.id,
        keyword: r.keyword,
        mode: r.mode ?? "record",
        instruction: r.instruction,
        chats: r.chats,
        senders: r.senders,
      })),
    },
  });
  return {
    id: "ag1",
    workspacePath: "/ws/ag1",
    config,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  };
}

function makeService(row: AgentRow | null, opts?: { failInsert?: boolean }) {
  const db = openDb(":memory:");
  const port = sqliteProactiveAdapter(db);
  const svc = createProactiveService({
    port: opts?.failInsert
      ? {
          insertEvent: () => {
            throw new Error("disk full");
          },
          listEvents: (f) => port.listEvents(f),
        }
      : port,
    agentSvc: {
      getById: async () => {
        if (!row) throw new Error("agent not found");
        return row;
      },
    },
    now: () => 1234,
    idGen: () => `ev-${Math.random().toString(36).slice(2, 8)}`,
  });
  return { svc, port };
}

/** Assessment-aware harness: controllable gate, model answer and promotion. */
function makeAssessingService(opts: {
  mode: "off" | "observe" | "auto";
  raw: string | Error;
  cards?: Array<{ id: string; name: string; description?: string; skills?: string[] }>;
  failInsert?: boolean;
}) {
  const db = openDb(":memory:");
  const port = sqliteProactiveAdapter(db);
  const promotions: Array<{ toAgentId: string; instruction: string }> = [];
  const modelCalls: string[] = [];
  const svc = createProactiveService({
    port: opts.failInsert
      ? {
          insertEvent: () => {
            throw new Error("disk full");
          },
          listEvents: (f) => port.listEvents(f),
        }
      : port,
    agentSvc: {
      getById: async () => agentRowWithRules([]),
    },
    assessmentGate: () => ({ mode: opts.mode }),
    assessmentCall: (input) => {
      modelCalls.push(input.text);
      if (opts.raw instanceof Error) return Promise.reject(opts.raw);
      return Promise.resolve(opts.raw);
    },
    listCards: () =>
      Promise.resolve(
        (opts.cards ?? [
          { id: "ag1", name: "通用", skills: ["杂活"] },
          { id: "fe", name: "前端工", skills: ["前端"] },
        ]) as never,
      ),
    promote: ({ toAgentId, instruction }) => {
      promotions.push({ toAgentId, instruction });
      return Promise.resolve();
    },
    now: () => 1234,
    idGen: () => `ev-${Math.random().toString(36).slice(2, 8)}`,
  });
  return { svc, port, promotions, modelCalls };
}
const OBSERVED = {
  agentId: "ag1",
  conversationId: "conv1",
  senderMemberId: "human:lark:ou_alice",
  source: { kind: "lark" as const, chatId: "oc_dev" },
  text: "deploy is broken",
};

describe("createProactiveService.evaluate", () => {
  test("no rules configured: null, and nothing recorded", async () => {
    const { svc, port } = makeService(agentRowWithRules([]));
    expect(await svc.evaluate(OBSERVED)).toBeNull();
    expect(port.listEvents({ limit: 10 })).toHaveLength(0);
  });

  test("record rule: a would-do row, no promotion decision", async () => {
    const { svc, port } = makeService(
      agentRowWithRules([{ id: "r1", keyword: "deploy", mode: "record" }]),
    );
    const decision = await svc.evaluate(OBSERVED);
    expect(decision?.rule.id).toBe("r1");
    expect(decision?.outcome).toBe("recorded");
    const events = port.listEvents({ limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentId: "ag1",
      ruleId: "r1",
      mode: "record",
      outcome: "recorded",
      chatId: "oc_dev",
      snippet: "deploy is broken",
    });
  });

  test("act rule: the event is recorded BEFORE the triggered decision", async () => {
    const { svc, port } = makeService(
      agentRowWithRules([{ id: "act1", keyword: "deploy", mode: "act", instruction: "去修" }]),
    );
    const decision = await svc.evaluate(OBSERVED);
    expect(decision?.outcome).toBe("triggered");
    const events = port.listEvents({ limit: 10 });
    expect(events[0]).toMatchObject({ ruleId: "act1", mode: "act", outcome: "triggered" });
  });

  test("rule for another chat: null (the observe seam scoped it away)", async () => {
    const { svc } = makeService(
      agentRowWithRules([{ id: "r1", keyword: "deploy", chats: ["oc_other"] }]),
    );
    expect(await svc.evaluate(OBSERVED)).toBeNull();
  });

  test("a config-load failure degrades to null (the human message is unaffected)", async () => {
    const { svc } = makeService(null);
    expect(await svc.evaluate(OBSERVED)).toBeNull();
  });

  test("an event-write failure cancels the act (no promotion without an audit row)", async () => {
    const { svc } = makeService(
      agentRowWithRules([{ id: "act1", keyword: "deploy", mode: "act", instruction: "去修" }]),
      { failInsert: true },
    );
    expect(await svc.evaluate(OBSERVED)).toBeNull();
  });
  test("listEvents returns newest first and filters by agent", async () => {
    const db = openDb(":memory:");
    const port = sqliteProactiveAdapter(db);
    let tick = 0;
    const timed = createProactiveService({
      port,
      agentSvc: {
        getById: async () => agentRowWithRules([{ id: "r1", keyword: "deploy" }]),
      },
      now: () => 100 + tick++ * 10,
      idGen: () => `ev-${tick}`,
    });
    await timed.evaluate(OBSERVED);
    await timed.evaluate(OBSERVED);
    const events = port.listEvents({ limit: 10 });
    expect(events).toHaveLength(2);
    expect(events[0]!.ts).toBeGreaterThanOrEqual(events[1]!.ts);
    expect(events[0]!.id).not.toBe(events[1]!.id);
    expect(port.listEvents({ agentId: "nobody", limit: 10 })).toHaveLength(0);
    expect(timed.listEvents({ limit: 1 })).toHaveLength(1);
  });
});

describe("ADR 0048 semantic assessment (the net under the rules)", () => {
  const ACCEPT_FE = JSON.stringify({
    accept: true,
    agent: "fe",
    reason: "前端报障",
    instruction: "修复登录转圈（原话：点登录转圈没反应）",
  });

  test("gate off: a rule miss schedules nothing — the model is never called", async () => {
    const { svc, port, modelCalls } = makeAssessingService({ mode: "off", raw: ACCEPT_FE });
    expect(await svc.evaluate(OBSERVED)).toBeNull();
    await svc.drain();
    expect(modelCalls).toHaveLength(0);
    expect(port.listEvents({ limit: 10 })).toHaveLength(0);
  });

  test("observe + accept: a would-accept row, no promotion", async () => {
    const { svc, port, promotions } = makeAssessingService({ mode: "observe", raw: ACCEPT_FE });
    expect(await svc.evaluate(OBSERVED)).toBeNull();
    await svc.drain();
    const events = port.listEvents({ limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ruleId: "assessment",
      mode: "assessment",
      outcome: "recorded",
      chatId: "oc_dev",
    });
    expect(promotions).toHaveLength(0);
  });

  test("auto + accept: the event lands FIRST, then the promotion to the chosen agent", async () => {
    const { svc, port, promotions } = makeAssessingService({ mode: "auto", raw: ACCEPT_FE });
    expect(await svc.evaluate(OBSERVED)).toBeNull();
    await svc.drain();
    const events = port.listEvents({ limit: 10 });
    expect(events[0]).toMatchObject({ outcome: "triggered", mode: "assessment" });
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({ toAgentId: "fe" });
    expect(promotions[0]!.instruction).toContain("点登录转圈没反应");
  });

  test("reject: nothing recorded (noise control), nothing promoted", async () => {
    const raw = JSON.stringify({ accept: false, agent: null, reason: "闲聊" });
    const { svc, port, promotions } = makeAssessingService({ mode: "auto", raw });
    await svc.evaluate(OBSERVED);
    await svc.drain();
    expect(port.listEvents({ limit: 10 })).toHaveLength(0);
    expect(promotions).toHaveLength(0);
  });

  test("model failure: an error event is the observability; no promotion, no throw", async () => {
    const { svc, port, promotions } = makeAssessingService({
      mode: "auto",
      raw: new Error("429 rate limited"),
    });
    await svc.evaluate(OBSERVED);
    await svc.drain();
    const events = port.listEvents({ limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "error", ruleId: "assessment" });
    expect(promotions).toHaveLength(0);
  });

  test("unparseable model output counts as a failure, not an accept", async () => {
    const { svc, port } = makeAssessingService({ mode: "auto", raw: "我觉得可以吧" });
    await svc.evaluate(OBSERVED);
    await svc.drain();
    expect(port.listEvents({ limit: 10 }).map((e) => e.outcome)).toEqual(["error"]);
  });

  test("accept whose event write fails does NOT promote (no act without an audit row)", async () => {
    const { svc, promotions } = makeAssessingService({
      mode: "auto",
      raw: ACCEPT_FE,
      failInsert: true,
    });
    await svc.evaluate(OBSERVED);
    await svc.drain();
    expect(promotions).toHaveLength(0);
  });

  test("a rule hit never reaches the model — rules stay the fast path", async () => {
    const db = openDb(":memory:");
    const port = sqliteProactiveAdapter(db);
    const modelCalls: string[] = [];
    const svc = createProactiveService({
      port,
      agentSvc: {
        getById: async () => agentRowWithRules([{ id: "r1", keyword: "deploy", mode: "record" }]),
      },
      assessmentGate: () => ({ mode: "auto" }),
      assessmentCall: (input) => {
        modelCalls.push(input.text);
        return Promise.resolve(ACCEPT_FE);
      },
      listCards: () => Promise.resolve([{ id: "ag1", name: "x", skills: [] }] as never),
      now: () => 1,
      idGen: () => `ev-${Math.random().toString(36).slice(2, 8)}`,
    });
    const decision = await svc.evaluate(OBSERVED);
    await svc.drain();
    expect(decision?.rule.id).toBe("r1");
    expect(modelCalls).toHaveLength(0);
  });
});
