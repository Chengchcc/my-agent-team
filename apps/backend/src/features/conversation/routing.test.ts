import { describe, expect, test } from "bun:test";
import { resolveTrigger } from "./routing.js";

describe("ADR 0041 response routing (derived from member count)", () => {
  test("1 member (e2e): a message with no mention auto-triggers that agent", () => {
    expect(resolveTrigger({ members: ["coder"], addressedTo: undefined })).toEqual(["coder"]);
  });

  test("1 member: an explicit mention of THE member still triggers", () => {
    expect(resolveTrigger({ members: ["coder"], addressedTo: ["coder"] })).toEqual(["coder"]);
  });

  test("1 member: mentioning someone else does NOT trigger (lark group today)", () => {
    expect(resolveTrigger({ members: ["coder"], addressedTo: ["writer"] })).toEqual([]);
  });

  test("2+ members (room): no mention = ledger-only, nobody triggers", () => {
    expect(resolveTrigger({ members: ["coder", "writer"], addressedTo: undefined })).toEqual([]);
  });

  test("2+ members: a mention of one member triggers exactly that member", () => {
    expect(resolveTrigger({ members: ["coder", "writer"], addressedTo: ["writer"] })).toEqual([
      "writer",
    ]);
  });

  test("2+ members: mentions of non-members trigger nobody", () => {
    expect(resolveTrigger({ members: ["coder", "writer"], addressedTo: ["stranger"] })).toEqual([]);
  });

  test("system inputs (reminder, workflow) carry their target explicitly", () => {
    // A reminder authored by writer in a room: delivery carries addressedTo
    // [writer]; without it the room rule would swallow it forever.
    expect(resolveTrigger({ members: ["coder", "writer"], addressedTo: ["writer"] })).toEqual([
      "writer",
    ]);
    // The author is gone (removed member): the reminder must not fire into
    // a branch that no longer has an owner — drop it, log at the caller.
    expect(resolveTrigger({ members: ["coder"], addressedTo: ["writer"] })).toEqual([]);
  });

  test("no members at all (legacy agentless row): nobody triggers", () => {
    expect(resolveTrigger({ members: [], addressedTo: undefined })).toEqual([]);
    expect(resolveTrigger({ members: [], addressedTo: ["anyone"] })).toEqual([]);
  });
});
