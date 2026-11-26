import { describe, expect, test } from "bun:test";
import { definitionFacts } from "./definition-facts";

const valid = {
  version: 1,
  id: "lint",
  meta: { name: "Nightly lint", description: "Check the wiki", status: "active" },
  triggers: [{ type: "cron", cron: "0 4 * * *" }],
  nodes: [
    { id: "start", type: "start" },
    { id: "check", type: "script", code: "echo hi" },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [
    { from: "start", to: "check" },
    { from: "check", to: "done" },
  ],
};

describe("definitionFacts", () => {
  test("reads a definition that parses", () => {
    const facts = definitionFacts(valid);
    expect(facts.valid).toBeTruthy();
    expect(facts.issues).toEqual([]);
    expect(facts.nodeCount).toBe(3);
    expect(facts.edgeCount).toBe(2);
    expect(facts.scriptNodes).toBe(1);
    expect(facts.name).toBe("Nightly lint");
    expect(facts.status).toBe("active");
  });

  test("reports the saved trigger, and manual when none is declared", () => {
    expect(definitionFacts(valid).trigger).toEqual({
      mode: "cron",
      cron: "0 4 * * *",
      enabled: true,
    });
    const disabled = { ...valid, triggers: [{ type: "cron", cron: "0 4 * * *", enabled: false }] };
    expect(definitionFacts(disabled).trigger.enabled).toBeFalsy();
    expect(definitionFacts({ ...valid, triggers: [] }).trigger).toEqual({
      mode: "manual",
      cron: null,
      enabled: false,
    });
  });

  test("a definition that does not parse still says what is wrong and how big it is", () => {
    const broken = {
      ...valid,
      nodes: [
        { id: "start", type: "start" },
        { id: "start-2", type: "start" },
        { id: "done", type: "end" },
      ],
    };
    const facts = definitionFacts(broken);
    expect(facts.valid).toBeFalsy();
    expect(facts.issues.length).toBeGreaterThan(0);
    expect(facts.nodeCount).toBe(3);
    expect(facts.trigger.mode).toBe("cron");
  });

  test("something that is not a definition at all reads as invalid and empty", () => {
    const facts = definitionFacts("text");
    expect(facts.valid).toBeFalsy();
    expect(facts.nodeCount).toBe(0);
    expect(facts.trigger.mode).toBe("manual");
  });
});
