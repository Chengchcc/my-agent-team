import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TurnSegment } from "@/lib/conversation-reducer";
import { ReasoningTrace } from "./ReasoningTrace";

function makeTurnSegment(overrides?: {
  toolIsError?: boolean;
}): Extract<TurnSegment, { kind: "turn" }> {
  return {
    kind: "turn",
    id: "turn-1",
    sender: { memberId: "m-pa", kind: "agent", displayName: "Personal Agent", agentId: "pa" },
    rounds: [
      {
        kind: "message",
        id: "run:r1:m1",
        seq: 2,
        sender: { memberId: "m-pa", kind: "agent", displayName: "Personal Agent", agentId: "pa" },
        content: {
          id: "run:r1:m1",
          role: "assistant",
          state: "done",
          text: "",
          blocks: [
            { type: "thinking", text: "Let me inspect README first." },
            { type: "tool_use", id: "call-1", name: "read_file", input: { path: "README.md" } },
          ],
        },
      },
      {
        kind: "message",
        id: "run:r1:m2",
        seq: 3,
        sender: { memberId: "m-pa", kind: "agent", displayName: "Personal Agent", agentId: "pa" },
        content: {
          id: "run:r1:m2",
          role: "tool",
          state: "done",
          text: "",
          blocks: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: overrides?.toolIsError ? "ENOENT" : "# README",
              is_error: overrides?.toolIsError ?? false,
            },
          ],
        },
      },
    ],
    conclusion: {
      kind: "message",
      id: "run:r1:m3",
      seq: 4,
      sender: { memberId: "m-pa", kind: "agent", displayName: "Personal Agent", agentId: "pa" },
      content: {
        id: "run:r1:m3",
        role: "assistant",
        state: "done",
        text: "Final concise answer.",
      },
    },
  };
}

describe("ReasoningTrace", () => {
  test("renders the conclusion before the collapsed thinking & tooling footer drawer", () => {
    const html = renderToStaticMarkup(<ReasoningTrace segment={makeTurnSegment()} />);
    expect(html).toContain("Final concise answer.");
    expect(html).toContain('data-slot="reasoning-trace-drawer"');
    expect(html.indexOf("Final concise answer.")).toBeLessThan(
      html.indexOf('data-slot="reasoning-trace-drawer"'),
    );
    expect(html).toContain("1 steps");
    // Default collapsed: internal thinking/tool body is not expanded on initial render
    expect(html).not.toContain("Let me inspect README first.");
    expect(html).not.toContain("read_file");
  });

  test("surfaces failed tool count in the collapsed footer bar and expands details when defaultOpen", () => {
    const html = renderToStaticMarkup(
      <ReasoningTrace segment={makeTurnSegment({ toolIsError: true })} defaultOpen />,
    );
    expect(html).toContain('data-testid="trace-error-count"');
    expect(html).toContain("1 failed");
    expect(html).toContain("Let me inspect README first.");
    expect(html).toContain("read_file");
  });

  test("keeps consecutive standalone agent replies visible instead of folding them into the thinking drawer", () => {
    const seg: Extract<TurnSegment, { kind: "turn" }> = {
      kind: "turn",
      id: "turn-burst",
      sender: { memberId: "m-pa", kind: "agent", displayName: "Personal Agent", agentId: "pa" },
      rounds: [
        {
          kind: "message",
          id: "run:r1:m1",
          seq: 1,
          sender: { memberId: "m-pa", kind: "agent", displayName: "Personal Agent", agentId: "pa" },
          content: {
            id: "run:r1:m1",
            role: "assistant",
            state: "done",
            text: "First standalone report from run 1.",
          },
        },
      ],
      conclusion: {
        kind: "message",
        id: "run:r2:m1",
        seq: 2,
        sender: { memberId: "m-pa", kind: "agent", displayName: "Personal Agent", agentId: "pa" },
        content: {
          id: "run:r2:m1",
          role: "assistant",
          state: "done",
          text: "Second standalone report from run 2.",
        },
      },
    };
    const html = renderToStaticMarkup(<ReasoningTrace segment={seg} />);
    expect(html).toContain("First standalone report from run 1.");
    expect(html).toContain("Second standalone report from run 2.");
    expect(html).not.toContain('data-slot="reasoning-trace-drawer"');
  });
});
