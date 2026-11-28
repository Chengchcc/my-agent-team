import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { artifactContentQuery } from "@/features/artifacts/queries";
import type { ArtifactContent, ArtifactMeta } from "@/lib/api";
import { ArtifactCard, inlineVisualKind } from "./ArtifactCard";

function makeMeta(overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    url: "artifacts://demo/file.txt",
    folder: "demo",
    filename: "file.txt",
    size: 512,
    mimeType: "text/plain",
    encoding: "utf8",
    updatedAt: 1000,
    ...overrides,
  };
}

function renderCard(artifact: ArtifactMeta, cached?: ArtifactContent): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cached) {
    qc.setQueryData(artifactContentQuery(artifact.url, artifact.updatedAt).queryKey, cached);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ArtifactCard artifact={artifact} onPreview={() => {}} onDownload={() => {}} />
    </QueryClientProvider>,
  );
}

describe("inlineVisualKind", () => {
  test("classifies HTML, images/SVG, and non-visual documents", () => {
    expect(inlineVisualKind({ filename: "card.html", mimeType: "text/html" })).toBe("html");
    expect(inlineVisualKind({ filename: "card.htm", mimeType: "text/plain" })).toBe("html");
    expect(inlineVisualKind({ filename: "badge.svg", mimeType: "image/svg+xml" })).toBe("image");
    expect(inlineVisualKind({ filename: "badge.svg", mimeType: "application/octet-stream" })).toBe(
      "image",
    );
    expect(inlineVisualKind({ filename: "shot.png", mimeType: "image/png" })).toBe("image");
    expect(inlineVisualKind({ filename: "metrics.json", mimeType: "application/json" })).toBeNull();
    expect(inlineVisualKind({ filename: "report.md", mimeType: "text/markdown" })).toBeNull();
  });
});

describe("ArtifactCard", () => {
  test("renders inline sandboxed iframe preview for HTML artifacts without raw artifacts:// subtitle", () => {
    const artifact = makeMeta({
      url: "artifacts://e2e-demo/status-card.html",
      folder: "e2e-demo",
      filename: "status-card.html",
      size: 1700,
      mimeType: "text/html",
    });
    const html = renderCard(artifact, {
      content: "<h1>Live Card</h1>",
      encoding: "utf8",
      mimeType: "text/html",
      size: 18,
    });
    expect(html).toContain("<iframe");
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain("status-card.html");
    expect(html).toContain("e2e-demo");
    expect(html).toContain("Expand");
    expect(html).toContain("Source");
    // Subtitle omits raw artifacts:// protocol clutter (kept only in tooltip title)
    expect(html).not.toContain(">artifacts://e2e-demo/status-card.html");
  });

  test("renders inline image preview for SVG artifacts", () => {
    const artifact = makeMeta({
      url: "artifacts://e2e-demo/badge.svg",
      folder: "e2e-demo",
      filename: "badge.svg",
      size: 453,
      mimeType: "image/svg+xml",
    });
    const html = renderCard(artifact, {
      content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      encoding: "utf8",
      mimeType: "image/svg+xml",
      size: 45,
    });
    expect(html).toContain("<img");
    expect(html).toContain("data:image/svg+xml;charset=utf-8,");
    expect(html).toContain("Expand");
  });

  test("keeps non-visual JSON artifacts as compact row cards", () => {
    const artifact = makeMeta({
      url: "artifacts://e2e-demo/metrics.json",
      folder: "e2e-demo",
      filename: "metrics.json",
      size: 76,
      mimeType: "application/json",
    });
    const html = renderCard(artifact);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<img");
    expect(html).toContain("metrics.json");
    expect(html).toContain("Preview");
  });
});
