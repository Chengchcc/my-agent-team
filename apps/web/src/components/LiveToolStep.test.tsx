import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LiveToolCall } from "@/lib/transient-reducer";
import { LiveToolStep } from "./LiveToolStep";

function call(over: Partial<LiveToolCall> = {}): LiveToolCall {
  return { runId: "r1", callId: "c1", name: "bash", state: "running", ...over };
}

describe("LiveToolStep", () => {
  test("shows the tool-authored activity line when the child sent one", () => {
    const html = renderToStaticMarkup(
      <LiveToolStep tool={call({ activity: "running: bun test apps/backend" })} />,
    );
    expect(html).toContain("running: bun test apps/backend");
    // The raw tool name stays visible as secondary context.
    expect(html).toContain("bash");
  });

  test("falls back to the tool name and invents nothing when activity is absent", () => {
    const html = renderToStaticMarkup(<LiveToolStep tool={call({ name: "mcp__db__query" })} />);
    expect(html).toContain("mcp__db__query");
    expect(html).not.toContain("running:");
  });
});
