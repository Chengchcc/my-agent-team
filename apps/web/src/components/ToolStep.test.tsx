import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolStep } from "./ToolStep";

describe("ToolStep", () => {
  test("renders a compact single-line row with tool name, inline arg preview, and status", () => {
    const html = renderToStaticMarkup(
      <ToolStep
        name="bash"
        input={{ command: "bun test apps/web" }}
        result={{ content: "490 pass", isError: false }}
      />,
    );
    expect(html).toContain('data-slot="tool-step"');
    expect(html).toContain('data-status="done"');
    expect(html).toContain("bash");
    expect(html).toContain("bun test apps/web");
    // Collapsed by default: payload output is hidden until clicked
    expect(html).not.toContain("490 pass");
  });

  test("marks failed tool steps with error status", () => {
    const html = renderToStaticMarkup(
      <ToolStep
        name="read_file"
        input={{ path: "missing.ts" }}
        result={{ content: "ENOENT", isError: true }}
      />,
    );
    expect(html).toContain('data-status="error"');
    expect(html).toContain("missing.ts");
  });
});
