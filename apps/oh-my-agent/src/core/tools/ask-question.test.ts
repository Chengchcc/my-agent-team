import { describe, expect, test } from "bun:test";
import type { AskQuestionInput, AskQuestionResult } from "@chengchenccc/agent-contract";
import { createAskQuestionTool } from "./ask-question.js";

/** The native ask_question tool is the standalone path into the HITL ask
 *  pipeline. Its contract is "validate hard, then fail CLOSED": a malformed
 *  question list or a missing/empty pipeline must never look like a success,
 *  because the model treats a returned payload as the user's answer. */
const tool = createAskQuestionTool();

function ask(
  args: Record<string, unknown>,
  pipeline?: (input: AskQuestionInput) => Promise<AskQuestionResult | null>,
) {
  return tool.execute(args, undefined, pipeline ? { ask: pipeline } : undefined);
}

describe("ask_question input validation", () => {
  test("a missing or empty questions array is refused", async () => {
    expect(await ask({})).toEqual({ error: "questions must be a non-empty array" });
    expect(await ask({ questions: [] })).toEqual({
      error: "questions must be a non-empty array",
    });
    expect(await ask({ questions: "nope" })).toEqual({
      error: "questions must be a non-empty array",
    });
    expect(await ask({ questions: [null] })).toEqual({
      error: "each question must be an object",
    });
  });

  test("each question needs a string id and question text", async () => {
    expect(await ask({ questions: [{ id: "q1" }] })).toEqual({
      error: "each question needs string id and question",
    });
    expect(await ask({ questions: [{ id: 7, question: "why?" }] })).toEqual({
      error: "each question needs string id and question",
    });
  });

  test("a select question without options is refused (kind defaults to select)", async () => {
    expect(await ask({ questions: [{ id: "q1", question: "pick" }] })).toEqual({
      error: "question q1: select needs options",
    });
    expect(await ask({ questions: [{ id: "q1", question: "pick", options: [] }] })).toEqual({
      error: "question q1: select needs options",
    });
  });

  test("a text question needs no options", async () => {
    const result = await ask(
      { questions: [{ id: "q1", question: "why?", kind: "text" }] },
      async () =>
        ({ answers: [{ id: "q1", selectedValues: [], freeText: "because" }] }) as AskQuestionResult,
    );
    expect(result).toEqual({
      answers: [{ id: "q1", selectedValues: [], freeText: "because" }],
    });
  });
});

describe("ask_question fails closed", () => {
  test("no pipeline configured = an error result, never an empty answer", async () => {
    const result = await ask({ questions: [{ id: "q1", question: "pick", options: ["a"] }] });
    expect(result).toEqual({ error: "no ask pipeline configured" });
  });

  test("a cancelled pipeline (null) is an error, not an empty answer", async () => {
    const result = await ask(
      { questions: [{ id: "q1", question: "pick", options: ["a"] }] },
      async () => null,
    );
    expect(result).toEqual({ error: "ask pipeline returned no answer" });
  });

  test("a pipeline rejection propagates (the loop turns it into a tool error)", async () => {
    await expect(
      ask({ questions: [{ id: "q1", question: "pick", options: ["a"] }] }, async () => {
        throw new Error("overlay closed");
      }),
    ).rejects.toThrow("overlay closed");
  });

  test("the validated input (not the raw args) reaches the pipeline", async () => {
    let seen: AskQuestionInput | undefined;
    await ask(
      {
        questions: [
          { id: "q1", question: "pick one", options: ["a", "b"], multi: true },
          { id: "q2", question: "why?", kind: "text" },
        ],
      },
      async (input) => {
        seen = input;
        return { answers: [] } as AskQuestionResult;
      },
    );
    expect(seen?.questions).toHaveLength(2);
    expect(seen?.questions[0]).toMatchObject({ id: "q1", question: "pick one" });
    expect(seen?.questions[1]).toMatchObject({ id: "q2", kind: "text" });
  });
});
