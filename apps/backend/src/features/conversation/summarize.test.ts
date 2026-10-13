import { describe, expect, test } from "bun:test";
import { createModelRuntime, type Provider } from "@chengchenccc/ai";
import {
  createConfiguredSummarizer,
  createSummarizer,
  createSummaryRuntime,
  summarizerInput,
} from "./summarize.js";

/** A provider whose stream is scripted: no network, no ONNX, no model. */
function fakeProvider(texts: readonly string[]): Provider {
  return {
    id: "fake",
    name: "fake",
    getModels: () => [{ id: "sum", name: "sum" }],
    stream: function* () {
      for (const text of texts) yield { delta: { type: "text", text } };
    },
  } as unknown as Provider;
}

describe("conversation summarizer", () => {
  test("input drops blank turns and keeps the rest in order", () => {
    expect(summarizerInput(["  a  ", "   ", "", "b"])).toBe("a\n\nb");
    expect(summarizerInput(["   ", "\n"])).toBe("");
  });

  test("streams the transcript to the model and returns its text, trimmed and bounded", async () => {
    const runtime = createModelRuntime();
    runtime.registerProvider(fakeProvider(["  part one ", "part two"]));
    const summarize = createSummarizer({
      runtime,
      credentialFor: () => ({ apiKey: "k" }),
      providerId: "fake",
      modelId: "sum",
    });

    expect(await summarize(["hello", "world"])).toBe("part one part two");
    // Nothing to summarise => no model call at all.
    expect(await summarize(["  "])).toBe("");
  });

  test("an over-long answer is truncated, never passed through unbounded", async () => {
    const runtime = createModelRuntime();
    runtime.registerProvider(fakeProvider(["x".repeat(5000)]));
    const summarize = createSummarizer({
      runtime,
      credentialFor: () => ({}),
      providerId: "fake",
      modelId: "sum",
    });

    expect((await summarize(["hello"]))!.length).toBe(1200);
  });

  test("unset config means no summarizer (compaction keeps answering 501)", () => {
    expect(createConfiguredSummarizer(undefined, () => ({}))).toBeUndefined();
  });

  test("a malformed config fails the boot instead of silently disabling compaction", () => {
    expect(() => createConfiguredSummarizer("deepseek", () => ({}))).toThrow(
      /BACKEND_SUMMARY_MODEL/,
    );
    expect(() => createConfiguredSummarizer("/m", () => ({}))).toThrow(/BACKEND_SUMMARY_MODEL/);
    expect(() => createConfiguredSummarizer("p/", () => ({}))).toThrow(/BACKEND_SUMMARY_MODEL/);
  });

  test("the runtime registers the builtin catalogue, key or no key", () => {
    // Registration is deliberately not key-filtered: a configured model with no
    // credential must fail loudly at the call, not read as "provider not found".
    expect(createSummaryRuntime().getProvider("deepseek")).toBeTruthy();
  });
});
