import { describe, test, expect } from "bun:test";
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
});
