import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LiveToolCall } from "@/lib/transient-reducer";
import { TimelineTransientTrace } from "./TimelineTransientTrace";

describe("TimelineTransientTrace", () => {
  test("renders a compact live running status bar showing the active tool and step count", () => {
    const tools: LiveToolCall[] = [
      { runId: "r1", callId: "c1", name: "glob", state: "done" },
      { runId: "r1", callId: "c2", name: "read_file", state: "running", activity: "README.md" },
    ];
    const html = renderToStaticMarkup(
      <TimelineTransientTrace msgCount={0} thinking="checking files" tools={tools} />,
    );
    expect(html).toContain('data-slot="live-trace-bar"');
    expect(html).toContain("Running README.md (step 2)…");
    expect(html).toContain("animate-pulse");
  });

  test("surfaces failed tool count on the live status bar", () => {
    const tools: LiveToolCall[] = [{ runId: "r1", callId: "c1", name: "bash", state: "error" }];
    const html = renderToStaticMarkup(
      <TimelineTransientTrace msgCount={0} thinking="" tools={tools} />,
    );
    expect(html).toContain("Completed 1 steps, thinking…");
    expect(html).toContain("1 failed");
  });
});
