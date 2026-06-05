import { describe, expect, test } from "bun:test";
import { composeSystemPrompt } from "./system-prompt.js";

describe("composeSystemPrompt", () => {
  const base = {
    soul: "",
    user: "",
    tools: "",
    agents: "",
    today: "2026-06-05",
    yesterday: "2026-06-04",
    todayLog: "",
    yestLog: "",
  };

  test("5 sections in correct order", () => {
    const prompt = composeSystemPrompt({
      ...base,
      soul: "I am helpful",
      user: "User is dev",
      tools: "Use bash",
      agents: "Be safe",
    });

    const soulIdx = prompt.indexOf("<soul>");
    const userIdx = prompt.indexOf("<user>");
    const toolsIdx = prompt.indexOf("<tools>");
    const agentsIdx = prompt.indexOf("<agents>");
    const recentIdx = prompt.indexOf("<recent-work>");

    expect(soulIdx).toBeGreaterThan(-1);
    expect(soulIdx).toBeLessThan(userIdx);
    expect(userIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(agentsIdx);
    expect(agentsIdx).toBeLessThan(recentIdx);
  });

  test("empty sections preserve XML shell", () => {
    const prompt = composeSystemPrompt(base);

    expect(prompt).toInclude("<soul>\n\n</soul>");
    expect(prompt).toInclude("<user>\n\n</user>");
    expect(prompt).toInclude("<tools>\n\n</tools>");
    expect(prompt).toInclude("<agents>\n\n</agents>");
  });

  test("recent-work section shows yesterday before today", () => {
    const prompt = composeSystemPrompt({
      ...base,
      yesterday: "2026-06-04",
      today: "2026-06-05",
      yestLog: "Built feature X",
      todayLog: "Testing Y",
    });

    const yestIdx = prompt.indexOf("2026-06-04");
    const todayIdx = prompt.indexOf("2026-06-05");
    expect(yestIdx).toBeGreaterThan(-1);
    expect(todayIdx).toBeGreaterThan(-1);
    expect(yestIdx).toBeLessThan(todayIdx);
  });

  test("includes log content", () => {
    const prompt = composeSystemPrompt({
      ...base,
      yestLog: "Yesterday's work",
      todayLog: "Today's plan",
    });

    expect(prompt).toInclude("Yesterday's work");
    expect(prompt).toInclude("Today's plan");
  });

  test("matches architecture doc section format exactly", () => {
    const prompt = composeSystemPrompt({
      ...base,
      soul: "s",
      user: "u",
      tools: "t",
      agents: "a",
      yestLog: "y",
      todayLog: "d",
    });

    // Exact format from architecture doc §三
    expect(prompt).toBe(
      "<soul>\ns\n</soul>\n\n" +
        "<user>\nu\n</user>\n\n" +
        "<tools>\nt\n</tools>\n\n" +
        "<agents>\na\n</agents>\n\n" +
        "<recent-work>\n" +
        "## 2026-06-04\ny\n\n" +
        "## 2026-06-05\nd\n" +
        "</recent-work>",
    );
  });
});
