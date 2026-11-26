import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBubble } from "./MessageBubble";

describe("MessageBubble", () => {
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

  test("renders the user message as a left-aligned surface card without a 1:1 avatar", () => {
    const html = renderToStaticMarkup(<MessageBubble align="right" content="hello" state="done" />);
    expect(html).toContain('data-align="right"');
    expect(html).toContain("items-start");
    expect(html).toContain("hello");
    expect(html).not.toContain("role-avatar");
  });

  test("renders agent replies full-width without avatars and shows sender name only when showSender is set", () => {
    const withLabel = renderToStaticMarkup(
      <MessageBubble align="left" name="Personal Agent" content="a" showSender />,
    );
    const plain = renderToStaticMarkup(
      <MessageBubble align="left" name="Personal Agent" content="b" />,
    );
    expect(withLabel).toContain("Personal Agent");
    expect(withLabel).not.toContain("role-avatar");
    expect(plain).not.toContain("Personal Agent");
    expect(plain).not.toContain("role-avatar");
  });
});
