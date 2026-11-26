import { describe, expect, test } from "bun:test";
import type { PendingProposalRow } from "@/lib/api";
import {
  isStaleSuggestion,
  projectFormSchema,
  projectFormValuesOf,
  reviewedPayload,
  sameValues,
  suggestionFromProposal,
  withSuggestion,
} from "./editor-model";

const form = {
  name: "Agent Workspace",
  repoUrl: "https://example.invalid/a.git",
  defaultBranch: "main",
};

function proposal(id: string, payload: unknown): PendingProposalRow {
  return { id, kind: "project_update", targetId: "p1", payload, createdAt: 1 };
}

describe("project editor model", () => {
  test("the form starts from the saved project, or empty for a new one", () => {
    expect(projectFormValuesOf({ name: "a", repoUrl: null, defaultBranch: "dev" })).toEqual({
      name: "a",
      repoUrl: "",
      defaultBranch: "dev",
    });
    expect(projectFormValuesOf(null)).toEqual({ name: "", repoUrl: "", defaultBranch: "" });
  });

  test("a project needs a name", () => {
    const empty = { name: "   ", repoUrl: "", defaultBranch: "" };
    expect(projectFormSchema.safeParse(empty).success).toBe(false);
    expect(projectFormSchema.safeParse(form).success).toBe(true);
  });

  test("only the fields a suggestion names are filled in", () => {
    const suggestion = suggestionFromProposal(
      proposal("s1", { projectId: "p1", defaultBranch: "develop", proposedBy: "pa" }),
      form,
    );
    expect(suggestion?.values).toEqual({ defaultBranch: "develop" });
    expect(withSuggestion(form, suggestion!)).toEqual({ ...form, defaultBranch: "develop" });
  });

  test("a proposal that names none of the form's fields is not a suggestion", () => {
    expect(suggestionFromProposal(proposal("s1", { projectId: "p1" }), form)).toBeNull();
    expect(suggestionFromProposal(proposal("s2", "not an object"), form)).toBeNull();
  });

  test("a suggestion goes stale once the form moves on, and not before", () => {
    const suggestion = suggestionFromProposal(proposal("s1", { name: "New" }), form);
    if (!suggestion) throw new Error("expected a suggestion");
    expect(isStaleSuggestion(form, suggestion)).toBe(false);
    expect(isStaleSuggestion({ ...form, name: "typed since" }, suggestion)).toBe(true);
    expect(sameValues(form, { ...form })).toBe(true);
    expect(sameValues(form, { ...form, repoUrl: "" })).toBe(false);
  });

  test("what the backend applies on save is the reviewed form, not the tool's values", () => {
    expect(reviewedPayload(form)).toEqual(form);
  });
});
