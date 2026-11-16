import { describe, expect, test } from "bun:test";
import { GOLDEN_INTENT_CASES } from "./golden-intent.cases.js";
import { missingSlots, needsHumanAuthority, parseBrief, VERBS } from "./intent.js";

/** ADR 0056: the corpus is data; this file holds it to the facet tables.
 *
 *  It cannot check that a MODEL picks the right verb — that needs a model and
 *  lives in `scripts/golden-intent.ts`. What it can check, for free, on every
 *  PR: every expected brief is expressible under the current tables, every
 *  declared gap is exactly what the code computes, and the cases still cover
 *  every verb. A table change that makes a documented request unexpressible
 *  fails here rather than in production. */
describe("golden intent corpus", () => {
  test("covers every verb, and has something to decompose", () => {
    expect(GOLDEN_INTENT_CASES.length).toBeGreaterThanOrEqual(20);
    const seen = new Set<string>();
    for (const c of GOLDEN_INTENT_CASES) {
      if (c.expected.action === "ask" || c.expected.action === "dispatch")
        seen.add(c.expected.verb);
      if (c.expected.action === "multi") for (const b of c.expected.briefs) seen.add(b.verb);
    }
    // `answer` is represented by the answer action, not by a brief: it never
    // leaves the desk, so it has no verb to dispatch with.
    expect([...seen].sort()).toEqual([...VERBS].filter((v) => v !== "answer").sort());
    expect(GOLDEN_INTENT_CASES.some((c) => c.expected.action === "multi")).toBe(true);
    expect(GOLDEN_INTENT_CASES.some((c) => c.expected.action === "answer")).toBe(true);
  });

  test("every ask case is refused for exactly the gaps it declares", () => {
    for (const c of GOLDEN_INTENT_CASES) {
      if (c.expected.action !== "ask") continue;
      const parsed = parseBrief({
        instruction: c.message,
        verb: c.expected.verb,
        deliverable: c.expected.deliverable,
        slots: c.expected.slots,
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect({ id: c.id, missing: [...missingSlots(parsed.brief)] }).toEqual({
        id: c.id,
        missing: [...c.expected.missing],
      });
    }
  });

  test("every dispatch case is complete and expressible", () => {
    for (const c of GOLDEN_INTENT_CASES) {
      if (c.expected.action !== "dispatch") continue;
      const parsed = parseBrief({
        instruction: c.message,
        verb: c.expected.verb,
        deliverable: c.expected.deliverable,
        slots: c.expected.slots,
        ...(c.expected.references ? { references: c.expected.references } : {}),
        ...(c.expected.reversibility ? { reversibility: c.expected.reversibility } : {}),
      });
      expect({ id: c.id, ok: parsed.ok }).toEqual({ id: c.id, ok: true });
      if (!parsed.ok) continue;
      expect({ id: c.id, missing: [...missingSlots(parsed.brief)] }).toEqual({
        id: c.id,
        missing: [],
      });
      expect({ id: c.id, needsHuman: needsHumanAuthority(parsed.brief) }).toEqual({
        id: c.id,
        needsHuman: c.expected.needsHuman ?? false,
      });
    }
  });

  test("every multi case decomposes into allowed pairs", () => {
    for (const c of GOLDEN_INTENT_CASES) {
      if (c.expected.action !== "multi") continue;
      expect(c.expected.briefs.length).toBeGreaterThan(1);
      for (const b of c.expected.briefs) {
        const parsed = parseBrief({
          instruction: c.message,
          verb: b.verb,
          deliverable: b.deliverable,
        });
        expect({ id: c.id, verb: b.verb, ok: parsed.ok }).toEqual({
          id: c.id,
          verb: b.verb,
          ok: true,
        });
      }
    }
  });

  test("an irreversible operate is the only case that demands a human", () => {
    const demanding = GOLDEN_INTENT_CASES.filter(
      (c) => c.expected.action === "dispatch" && c.expected.needsHuman === true,
    );
    expect(demanding.map((c) => c.id)).toEqual(["dispatch-operate-irreversible"]);
  });

  test("ids are unique (the corpus is a lookup table, not a list)", () => {
    const ids = GOLDEN_INTENT_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
