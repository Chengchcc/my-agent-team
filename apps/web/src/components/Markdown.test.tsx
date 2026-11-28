import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

function renderMarkdown(text: string): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Markdown text={text} />
    </QueryClientProvider>,
  );
}

describe("Markdown artifact links", () => {
  test("preserves bare artifacts:// URLs through sanitization and renders an inline chip", () => {
    const html = renderMarkdown("Check artifacts://e2e-demo/status-card.html for details.");
    expect(html).toContain("<button");
    expect(html).toContain("status-card.html");
    expect(html).toContain("HTML");
    // Must not degrade into a dead <a> displaying raw artifacts:// protocol text
    expect(html).not.toContain(">artifacts://e2e-demo/status-card.html</a>");
  });

  test("still strips unsafe javascript: hrefs during sanitization", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });
});
