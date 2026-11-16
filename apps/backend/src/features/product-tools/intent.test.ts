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
    expect(message).toContain("ask_question for all of them at once");
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
