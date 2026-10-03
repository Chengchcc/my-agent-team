import { describe, expect, test } from "bun:test";
import { MENTION_ALL_KEY } from "./event-parser.js";
import { resolveMentionTargets } from "./mention-targets.js";

const roster = [
  { agentId: "coder", name: "Coder" },
  { agentId: "data-analyst", name: "Data Analyst" },
];

function mentionsOf(...entries: Array<{ key?: string; name: string }>) {
  return entries.map((e) => ({ key: e.key ?? "ou_x", name: e.name }));
}

describe("ADR 0041 lark multi-member mention routing", () => {
  test("mentions resolve to member agent ids by display name, case-insensitive", () => {
    const ids = resolveMentionTargets({
      mentions: mentionsOf({ name: "Coder" }, { name: "DATA ANALYST" }),
      roster,
    });
    expect(ids.sort()).toEqual(["coder", "data-analyst"]);
  });

  test("the bot's own mention resolves to its agent id", () => {
    expect(
      resolveMentionTargets({
        mentions: mentionsOf({ name: "Coder" }),
        roster,
        selfAgentId: "coder",
        selfName: "Coder",
      }),
    ).toEqual(["coder"]);
  });

  test("@everyone never routes to anyone", () => {
    expect(
      resolveMentionTargets({
        mentions: mentionsOf({ key: MENTION_ALL_KEY, name: "所有人" }),
        roster,
        selfAgentId: "coder",
        selfName: "Coder",
      }),
    ).toEqual([]);
  });

  test("non-member names route to nobody (fail closed, not guessed)", () => {
    expect(
      resolveMentionTargets({
        mentions: mentionsOf({ name: "Stranger" }),
        roster,
        selfAgentId: "coder",
        selfName: "Coder",
      }),
    ).toEqual([]);
  });

  test("duplicates collapse; empty roster routes nobody", () => {
    expect(
      resolveMentionTargets({
        mentions: mentionsOf({ name: "coder" }, { name: "Coder" }),
        roster,
        selfAgentId: "coder",
        selfName: "Coder",
      }),
    ).toEqual(["coder"]);
    expect(
      resolveMentionTargets({
        mentions: mentionsOf({ name: "Coder" }),
        roster: [],
        selfAgentId: "coder",
        selfName: "Coder",
      }),
    ).toEqual([]);
  });
});
