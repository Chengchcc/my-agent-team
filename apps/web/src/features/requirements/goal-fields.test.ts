import { describe, expect, test } from "bun:test";
import { briefIsEmpty, briefMessage, changedFields, EMPTY_BRIEF, fieldsOf } from "./goal-fields";
import type { RequirementRecord } from "./queries";

const saved: RequirementRecord = {
  requirementId: "req-1",
  acceptedEvidence: null,
  acceptedAt: null,
  title: "Release checklist",
  goal: "Tidy the release list",
  background: "Why this matters",
  constraints: null,
  expectedDeliverables: null,
  acceptanceCriteria: null,
  status: "open",
  projectId: "p1",
  originConversationId: "conv-1",
  originSeq: 1,
  createdByAgentId: "default",
  createdAt: 1,
  updatedAt: 2,
};

describe("changedFields", () => {
  test("sends nothing when nothing moved", () => {
    expect(changedFields(saved, fieldsOf(saved))).toEqual({});
  });

  test("sends only the fields that changed, and clears an emptied optional field with null", () => {
    const fields = { ...fieldsOf(saved), background: "", acceptanceCriteria: "All boxes ticked" };
    expect(changedFields(saved, fields)).toEqual({
      background: null,
      acceptanceCriteria: "All boxes ticked",
    });
  });

  test("never sends an emptied title or goal: the endpoint refuses them", () => {
    const fields = { ...fieldsOf(saved), title: "", goal: "", constraints: "No UI changes" };
    expect(changedFields(saved, fields)).toEqual({ constraints: "No UI changes" });
  });

  test("a new record starts with empty fields", () => {
    expect(fieldsOf(null).title).toBe("");
  });
});

describe("briefMessage", () => {
  test("carries every filled line and drops the empty ones", () => {
    const brief = { ...EMPTY_BRIEF, goal: "Ship the release notes ", constraints: "No UI changes" };
    const message = briefMessage(brief, "Agent Workspace", "/requirement_memory");
    expect(message).toBe(
      [
        "/requirement_memory",
        "Please track this as a requirement:",
        "Goal: Ship the release notes",
        "Constraints: No UI changes",
        "Project: Agent Workspace",
      ].join("\n"),
    );
  });

  test("names a missing project as none", () => {
    const message = briefMessage({ ...EMPTY_BRIEF, goal: "Done" }, "", "");
    expect(message.split("\n").at(-1)).toBe("Project: none");
  });

  test("an empty brief is known to be empty", () => {
    expect(briefIsEmpty(EMPTY_BRIEF)).toBeTruthy();
    expect(briefIsEmpty({ ...EMPTY_BRIEF, goal: "  " })).toBeTruthy();
    expect(briefIsEmpty({ ...EMPTY_BRIEF, projectId: "p1" })).toBeFalsy();
  });
});
