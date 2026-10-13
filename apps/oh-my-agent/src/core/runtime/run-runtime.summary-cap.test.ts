import { describe, expect, test } from "bun:test";
import { SUMMARY_MAX_TOKENS, summaryMaxTokens } from "./run-runtime.js";

/** The summarizer shares the run's model, and therefore its output ceiling.
 *  This helper cannot raise that ceiling — it asks for a sane cap and never
 *  exceeds what the model allows (live 2026-10-13: a 64-token model cap starved
 *  summaries to empty text; see the empty-summary notice for that half). */
describe("summaryMaxTokens", () => {
  test("asks for the summary-sized cap when the model allows it", () => {
    expect(summaryMaxTokens(393_216)).toBe(SUMMARY_MAX_TOKENS);
    expect(summaryMaxTokens(8_192)).toBe(SUMMARY_MAX_TOKENS);
  });

  test("never asks for more than the model itself allows", () => {
    expect(summaryMaxTokens(4_096)).toBe(4_096);
    expect(summaryMaxTokens(2_048)).toBe(2_048);
    // A model capped below the summary budget keeps its own ceiling: a per-call
    // value cannot talk the provider into more than the model declares.
    expect(summaryMaxTokens(64)).toBe(64);
  });
});
