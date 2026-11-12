import { describe, expect, test } from "bun:test";
import {
  buildAssessmentPrompt,
  createConfiguredAssessment,
  parseAssessment,
} from "./assessment.js";

const CARDS = [
  { id: "fe", name: "前端工", description: "Web 界面", skills: ["react", "css"] },
  { id: "be", name: "后端工", description: "", skills: [] },
];

describe("parseAssessment", () => {
  test("a clean accept parses with agent, reason and instruction", () => {
    const raw = JSON.stringify({
      accept: true,
      agent: "fe",
      reason: "前端报障",
      instruction: "修复登录（原话：点登录转圈）",
    });
    expect(parseAssessment(raw)).toEqual({
      accept: true,
      agent: "fe",
      reason: "前端报障",
      instruction: "修复登录（原话：点登录转圈）",
    });
  });

  test("code fences and surrounding prose are tolerated", () => {
    const raw = '好的，判断如下：\n```json\n{"accept": false, "reason": "闲聊"}\n```\n以上。';
    expect(parseAssessment(raw)).toMatchObject({ accept: false, agent: null });
  });

  test("accept without an instruction is rejected — a task with no job", () => {
    const raw = JSON.stringify({ accept: true, agent: "fe", reason: "r" });
    expect(parseAssessment(raw)).toBeNull();
  });

  test("garbage, non-objects and missing accept are all null", () => {
    expect(parseAssessment("我觉得可以吧")).toBeNull();
    expect(parseAssessment("[1,2,3]")).toBeNull();
    expect(parseAssessment('{"reason": "no accept field"}')).toBeNull();
    expect(parseAssessment("")).toBeNull();
  });
});

describe("buildAssessmentPrompt", () => {
  test("the model sees the cards, the sender, the chat and the verbatim text", () => {
    const messages = buildAssessmentPrompt({
      text: "点登录转圈没反应",
      senderMemberId: "human:lark:ou_alice",
      chatId: "oc_dev",
      cards: CARDS,
    });
    const text = messages[0]!.text ?? "";
    expect(text).toContain("fe");
    expect(text).toContain("react");
    expect(text).toContain("ou_alice");
    expect(text).toContain("oc_dev");
    expect(text).toContain("点登录转圈没反应");
    expect(text).toContain("accept");
  });
});

describe("createConfiguredAssessment", () => {
  test("absent spec = no caller (assessment stays off, not broken)", () => {
    expect(createConfiguredAssessment(undefined, () => ({}))).toBeUndefined();
  });

  test("a malformed spec throws loudly at wiring time", () => {
    expect(() => createConfiguredAssessment("no-slash", () => ({}))).toThrow(/must be/);
    expect(() => createConfiguredAssessment("/leading", () => ({}))).toThrow(/must be/);
    expect(() => createConfiguredAssessment("trailing/", () => ({}))).toThrow(/must be/);
  });
});
