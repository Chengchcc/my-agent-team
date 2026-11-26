import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setLocale } from "@/lib/i18n";
import { formatNextRun } from "./cron-next";
import { describeCron } from "./TriggerPanel";

/** The schedule wording of the trigger panel: English stays exactly what it was before the
 *  dictionary, Chinese comes from the workflow dictionary. */
describe("schedule wording", () => {
  beforeEach(() => {
    setLocale("en");
  });
  afterEach(() => {
    // The locale is module state shared by every test file in this process: leave it as it was found.
    setLocale("en");
  });

  test("describeCron reads in English as it did before the dictionary", () => {
    expect(describeCron("0 2 * * 1-5")).toBe("Weekdays 02:00");
    expect(describeCron("0 2 * * 0")).toBe("Sun 02:00");
    expect(describeCron("30 * * * *")).toBe("Every hour at 30 min");
    expect(describeCron("0 2 * * *")).toBe("Daily 02:00");
    expect(describeCron("not cron")).toBe("not cron");
  });

  test("describeCron follows the locale", () => {
    setLocale("zh");
    expect(describeCron("0 2 * * 1-5")).toBe("\u5de5\u4f5c\u65e5 02:00");
    expect(describeCron("0 2 * * 0")).toBe("\u5468\u65e5 02:00");
    expect(describeCron("30 * * * *")).toBe("\u6bcf\u5c0f\u65f6 30 \u5206");
    expect(describeCron("0 2 * * *")).toBe("\u6bcf\u5929 02:00");
  });

  test("the next run says today and tomorrow in the active locale", () => {
    const now = new Date();
    const noon = (dayOffset: number) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, 12, 0, 0);
    expect(formatNextRun(noon(0))).toBe("Today 12:00");
    expect(formatNextRun(noon(1))).toBe("Tomorrow 12:00");
    expect(formatNextRun(null)).toBe("");
    setLocale("zh");
    expect(formatNextRun(noon(0))).toBe("\u4eca\u5929 12:00");
    expect(formatNextRun(noon(1))).toBe("\u660e\u5929 12:00");
  });
});
