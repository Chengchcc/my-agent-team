import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArtifactMeta } from "@/lib/api";
import { ArtifactPreview } from "./ArtifactPreview";

function makeMeta(over: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    url: "artifacts://demo/file.txt",
    folder: "demo",
    filename: "file.txt",
    mimeType: "text/plain",
    size: 42,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe("ArtifactPreview", () => {
  test("renders HTML artifacts inside a sandboxed iframe with Preview/Source toggle", () => {
    const html = renderToStaticMarkup(
      <ArtifactPreview
        artifact={makeMeta({ filename: "card.html", mimeType: "text/html" })}
        content="<h1>Hello HTML</h1>"
        encoding="utf8"
      />,
    );
    expect(html).toContain("<iframe");
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain("Preview");
    expect(html).toContain("Source");
  });

  test("pretty-prints valid JSON artifacts", () => {
    const html = renderToStaticMarkup(
      <ArtifactPreview
        artifact={makeMeta({ filename: "data.json", mimeType: "application/json" })}
        content='{"a":1,"b":[2,3]}'
        encoding="utf8"
      />,
    );
    expect(html).toContain("<pre");
    expect(html).toContain("&quot;a&quot;: 1");
  });

  test("renders SVG artifacts as images", () => {
    const html = renderToStaticMarkup(
      <ArtifactPreview
        artifact={makeMeta({ filename: "diagram.svg", mimeType: "image/svg+xml" })}
        content='<svg xmlns="http://www.w3.org/2000/svg"></svg>'
        encoding="utf8"
      />,
    );
    expect(html).toContain("<img");
  });
});
