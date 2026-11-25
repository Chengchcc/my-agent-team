import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBubble } from "./MessageBubble";

describe("MessageBubble error pill", () => {
  test("renders the error pill with the error text when state is error", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        align="left"
        name="Agent"
        agentId="a1"
        content="partial output"
        state="error"
        error="child process exited with code 1"
      />,
    );
    expect(html).toContain("message-error");
    expect(html).toContain("child process exited with code 1");
  });

  test("does not render the pill for a done message", () => {
    const html = renderToStaticMarkup(
      <MessageBubble align="left" name="Agent" agentId="a1" content="done" state="done" />,
    );
    expect(html).not.toContain("message-error");
  });

  test("the person's message is a right-aligned bubble with their mark on the right", () => {
    const html = renderToStaticMarkup(<MessageBubble align="right" content="hello" state="done" />);
    expect(html).toContain('data-align="right"');
    expect(html).toContain("rounded-br-[3px]");
    expect(html.indexOf("hello")).toBeLessThan(html.lastIndexOf("role-avatar"));
  });

  test("an agent message shows its mark and name only on the first of a group", () => {
    const first = renderToStaticMarkup(
      <MessageBubble align="left" name="Personal Agent" content="a" showSender />,
    );
    const next = renderToStaticMarkup(
      <MessageBubble align="left" name="Personal Agent" content="b" />,
    );
    expect(first).toContain("Personal Agent");
    expect(first).toContain("role-avatar");
    expect(next).not.toContain("Personal Agent");
    expect(next).not.toContain("role-avatar");
  });
});
