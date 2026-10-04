import { describe, expect, test } from "bun:test";
import { nextCronRun } from "./cron.js";

describe("cron next-run (reminder recurrence)", () => {
  test("a daily 9am expression resolves to the next 9am", () => {
    const from = new Date("2026-10-04T12:00:00Z");
    const next = nextCronRun("0 9 * * *", from);
    expect(next?.getUTCDate()).toBe(5);
    expect(next?.getUTCHours()).toBe(9);
  });

  test("an unparseable expression is null (fail closed, never guessed)", () => {
    expect(nextCronRun("not a cron", new Date())).toBeNull();
    expect(nextCronRun("* * *", new Date())).toBeNull();
  });

  test("a step expression lands on the step grid", () => {
    const from = new Date("2026-10-04T00:00:00Z");
    const next = nextCronRun("*/15 * * * *", from);
    expect(next?.getUTCMinutes()).toBe(15);
  });
});
