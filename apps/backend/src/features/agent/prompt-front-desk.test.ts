import { describe, expect, test } from "bun:test";
import { FRONT_DESK_DISCIPLINE } from "./prompt-front-desk.js";

/** ADR 0061 D4: the interruption rules ride every front-desk turn. They are
 *  pinned by presence, not by wording — the sentence may be rephrased, the
 *  rule may not disappear. (Model behaviour is pinned separately by the
 *  golden replay; that run is a distribution, not a unit test.) */
describe("front desk attention discipline", () => {
  test("the five rules are present", () => {
    expect(FRONT_DESK_DISCIPLINE).toContain("Register before asking");
    expect(FRONT_DESK_DISCIPLINE).toContain("One decision, one question");
    expect(FRONT_DESK_DISCIPLINE).toContain("Fail visibly");
    expect(FRONT_DESK_DISCIPLINE).toContain("An answer is a command");
    expect(FRONT_DESK_DISCIPLINE).toContain("end the turn");
  });

  test("the fallback hole stays closed in words", () => {
    // The one failure this section exists to prevent: a broken tool turning
    // into a plain-text question (the protocol downgrade).
    expect(FRONT_DESK_DISCIPLINE).toMatch(/never ask the same thing/i);
    expect(FRONT_DESK_DISCIPLINE).toMatch(/downgrade/i);
  });

  test("routing section is still there — attention did not replace it", () => {
    expect(FRONT_DESK_DISCIPLINE).toContain("## Routing (you are the front desk)");
    expect(FRONT_DESK_DISCIPLINE).toContain("DISPATCH");
  });
});
