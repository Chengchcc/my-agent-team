import { describe, expect, test } from "bun:test";
import { renderPrompt } from "./render.js";

describe("renderPrompt", () => {
  test("interpolates {{var}} placeholders", () => {
    const result = renderPrompt("Hello {{name}}, your task is {{task}}", {
      name: "Alice",
      task: "review",
    });
    expect(result).toBe("Hello Alice, your task is review");
  });

  test("missing vars become empty string", () => {
    const result = renderPrompt("Hello {{name}}, task: {{missing}}", { name: "Bob" });
    expect(result).toBe("Hello Bob, task: ");
  });

  test("no vars — returns template unchanged", () => {
    expect(renderPrompt("No placeholders here", {})).toBe("No placeholders here");
  });

  test("edge case: {{a}}{{b}} concatenated vars", () => {
    expect(renderPrompt("{{a}}{{b}}", { a: "x", b: "y" })).toBe("xy");
  });

  test("nested dot-path lookup: {{deliverables.plan.summary}}", () => {
    const vars = {
      title: "Test Issue",
      deliverables: {
        plan: { summary: "Build feature X", ref: "https://doc.example/plan" },
        mr: { url: "https://git.example/mr/1" },
      },
    };
    const result = renderPrompt(
      "Plan: {{deliverables.plan.summary}}, MR: {{deliverables.mr.url}}",
      vars,
    );
    expect(result).toBe("Plan: Build feature X, MR: https://git.example/mr/1");
  });

  test("missing nested path resolves to empty string", () => {
    const vars = {
      title: "Test",
      deliverables: { plan: { summary: "X" } },
    };
    const result = renderPrompt("MR: {{deliverables.mr.url}}", vars);
    expect(result).toBe("MR: ");
  });

  test("intermediate object (non-string leaf) resolves to empty string", () => {
    const vars = {
      deliverables: { plan: { summary: "X" } },
    };
    const result = renderPrompt("{{deliverables.plan}}", vars);
    expect(result).toBe("");
  });

  test("top-level missing key resolves to empty string", () => {
    const result = renderPrompt("{{nonexistent}}", { title: "T" });
    expect(result).toBe("");
  });

  test("spaces inside braces still not matched (regression)", () => {
    const result = renderPrompt("{{ x }}", { x: "y" });
    expect(result).toBe("{{ x }}");
  });
});
