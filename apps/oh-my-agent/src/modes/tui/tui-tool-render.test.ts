import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "./view-state.js";
import { renderLearnTool, renderTaskTool } from "./tui-tool-render.js";

function item(input: Record<string, unknown>, result?: unknown, streaming = false): TranscriptItem {
  return {
    kind: "tool",
    text: "learn",
    streaming,
    ...(input ? { input } : {}),
    ...(result !== undefined ? { result: result as Readonly<Record<string, unknown>> } : {}),
  };
}

describe("renderLearnTool", () => {
  test("shows the lesson body instead of args JSON", () => {
    const lines = renderLearnTool(
      item({ memory: "JWT expiry is 15m", context: "auth-service.ts" }, { learned: true }),
      false,
    );
    expect(lines.join("\n")).toContain("JWT expiry is 15m");
    expect(lines.join("\n")).toContain("auth-service.ts");
    expect(lines.join("\n")).toContain("stored");
    expect(lines.join("\n")).not.toContain('"memory"');
  });

  test("surfaces duplicate reason and streaming state", () => {
    const dup = renderLearnTool(
      item({ memory: "x" }, { learned: false, reason: "duplicate" }),
      false,
    );
    expect(dup.join("\n")).toContain("duplicate");
    const live = renderLearnTool(item({ memory: "x" }, undefined, true), false);
    expect(live.join("\n")).toContain("capturing");
  });
});

describe("renderTaskTool", () => {
  test("streaming task never shows a fake done marker", () => {
    const lines = renderTaskTool(
      { kind: "tool", text: "task…", streaming: true, input: {} },
      false,
    );
    expect(lines.join("\n")).not.toContain("(done)");
    expect(lines.join("\n")).toContain("running");
  });
});
