import { describe, expect, test } from "bun:test";
import {
  describeMissing,
  frameBrief,
  missingSlots,
  needsHumanAuthority,
  parseBrief,
} from "./intent.js";

/** Every valid dispatch in these tests needs these two facets first. */
const base = { instruction: "修一下登录", verb: "fix", deliverable: "change" };

describe("ADR 0054 dispatch facets", () => {
  test("an unknown verb is refused with the closed list, and pointed back at answering", () => {
    const parsed = parseBrief({ instruction: "x", verb: "refactor", deliverable: "change" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("verb (one of fix, build, review");
    expect(parsed.reason).toContain("answer it instead");
  });

  test("an impossible pair is a decomposition problem, not a task", () => {
    const parsed = parseBrief({ instruction: "x", verb: "review", deliverable: "change" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('not "change"');
    expect(parsed.reason).toContain("Split the work");
  });

  test("a fix lists its own gaps, in table order", () => {
    const parsed = parseBrief({ ...base, slots: { scope: "src/auth/**" } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(missingSlots(parsed.brief)).toEqual(["repro", "expected", "acceptance"]);
  });

  test("a review never asks for scope — that is the whole point of facets", () => {
    const parsed = parseBrief({
      instruction: "评一下这个 diff",
      verb: "review",
      deliverable: "report",
      slots: { target: "PR #42" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(missingSlots(parsed.brief)).toEqual(["criteria"]);
  });

  test("answer needs nothing: it never leaves the desk", () => {
    const parsed = parseBrief({
      instruction: "这个报错是什么意思",
      verb: "answer",
      deliverable: "answer",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(missingSlots(parsed.brief)).toEqual([]);
  });

  test("the rejection names every gap at once and forbids inventing them", () => {
    const message = describeMissing("investigate", ["question", "sources"]);
    expect(message).toContain("question, sources");
    expect(message).toContain("call ask_question once for all of them at once");
  });

  test("an irreversible operate is a human-authority question, not a prompt rule", () => {
    const parsed = parseBrief({
      instruction: "重启生产",
      verb: "operate",
      deliverable: "state-change",
      reversibility: "irreversible",
      slots: { environment: "prod", action: "restart api", rollback: "roll back to v1.19" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(needsHumanAuthority(parsed.brief)).toBe(true);

    const reversible = parseBrief({
      instruction: "重启 staging",
      verb: "operate",
      deliverable: "state-change",
      reversibility: "reversible",
      slots: { environment: "staging", action: "restart api", rollback: "n/a" },
    });
    if (!reversible.ok) throw new Error("fixture");
    expect(needsHumanAuthority(reversible.brief)).toBe(false);
  });

  test("reversibility defaults to irreversible: an unstated risk is the dangerous case", () => {
    const parsed = parseBrief({
      instruction: "重启",
      verb: "operate",
      deliverable: "state-change",
      slots: { environment: "?", action: "restart", rollback: "?" },
    });
    if (!parsed.ok) throw new Error("fixture");
    expect(parsed.brief.reversibility).toBe("irreversible");
  });

  test("the worker's framing is a spec: facets, slots, references, then the words verbatim", () => {
    const parsed = parseBrief({
      ...base,
      object: "登录页",
      objectKind: "code",
      references: ["seq:412"],
      slots: {
        repro: "点登录转圈",
        expected: "进入首页",
        scope: "src/auth/**",
        acceptance: "bun test src/auth",
      },
    });
    if (!parsed.ok) throw new Error("fixture");
    const framed = frameBrief({
      fromAgentId: "lead",
      brief: parsed.brief,
      instruction: "点登录转圈，帮我修一下",
      note: "来自值班群",
    });

    expect(framed).toContain("（由 lead 派发的任务）");
    expect(framed).toContain("动作：fix · 交付：change · 对象：code「登录页」");
    expect(framed).toContain("repro：点登录转圈");
    expect(framed).toContain("acceptance：bun test src/auth");
    expect(framed).toContain("引用：seq:412");
    expect(framed).toContain("请求者原文：\n点登录转圈，帮我修一下");
    // The original words come last and unedited: they are the evidence.
    expect(framed.endsWith("点登录转圈，帮我修一下")).toBe(true);
  });
});

describe("missing slots consult recall before letting the model ask (ADR 0055)", () => {
  test("evidence for a gap is printed with its ref, and the model is told to re-dispatch", () => {
    const message = describeMissing(
      "fix",
      ["repro", "scope"],
      [
        {
          slot: "repro",
          hits: [{ ref: "seq:412", text: "点登录一直转圈，复现三次都一样" }],
        },
      ],
    );
    expect(message).toContain("fix needs repro, scope.");
    expect(message).toContain("Recall from this turn may answer some of them:");
    expect(message).toContain("repro ← [seq:412] 点登录一直转圈");
    expect(message).toContain("Fill what the evidence actually answers");
    expect(message).toContain("Ask the human only for what is still missing");
  });

  test("no evidence keeps the plain message", () => {
    const message = describeMissing("fix", ["repro"]);
    expect(message).not.toContain("Recall from this turn");
    expect(message).toContain("do not invent values");
  });

  test("an irreversible operate still demands the human even when evidence exists", () => {
    const message = describeMissing(
      "operate",
      ["rollback"],
      [{ slot: "rollback", hits: [{ ref: "seq:9", text: "回滚到 v1.19" }] }],
    );
    expect(message).toContain("still needs the human's confirmation");
  });

  test("evidence matching is per-slot and never auto-fills", async () => {
    const { slotEvidence } = await import("../agent-run/recall.js");
    const hits = [
      {
        source: "history" as const,
        ref: "seq:1",
        at: 1,
        text: "用户说验收标准是 bun test 通过",
        why: "上次",
      },
      {
        source: "qa" as const,
        ref: "action:a",
        at: 2,
        text: "Q: 部署到哪个环境 A: staging",
        why: "pinned",
      },
    ];
    const evidence = slotEvidence(["acceptance", "environment"], hits);
    expect(evidence.map((e) => e.slot)).toEqual(["acceptance", "environment"]);
    expect(slotEvidence(["repro"], hits)).toEqual([]);
  });

  test("the brief carries the recall refs even when the model forgot them", async () => {
    const { recallRefs } = await import("../agent-run/recall.js");
    const refs = recallRefs(
      [
        { source: "history" as const, ref: "seq:412", at: 1, text: "x", why: "上次" },
        { source: "qa" as const, ref: "action:a", at: 2, text: "y", why: "pinned" },
      ],
      ["#123"],
    );
    expect(refs).toEqual(["#123", "seq:412", "action:a"]);
  });
});
