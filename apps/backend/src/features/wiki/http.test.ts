import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsWikiStore } from "./adapter-fs.js";
import { wikiRoutes } from "./http.js";
import { createWikiService } from "./service.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wiki-http-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("wiki HTTP routes", () => {
  test("list, read, query, backlinks, graph, lint, and 404 on missing pages", async () => {
    const svc = createWikiService({ store: createFsWikiStore(dir) });
    await svc.create({
      path: "decisions/auth.md",
      agentId: "default",
      title: "Auth Design",
      content: "Tokens use constant-time SHA-256 comparisons.",
      status: "confirmed",
      sources: ["conversation:c1"],
    });
    await svc.create({
      path: "concepts/security.md",
      agentId: "default",
      title: "Security Overview",
      content: "See [[Auth Design]] for details.",
      status: "draft",
      sources: [],
    });

    const app = wikiRoutes(svc);

    // List pages
    const pagesRes = await app.handle(new Request("http://localhost/api/wiki/pages"));
    expect(pagesRes.status).toBe(200);
    const { pages } = (await pagesRes.json()) as { pages: Array<{ path: string }> };
    expect(pages.map((p) => p.path).sort()).toEqual(["concepts/security.md", "decisions/auth.md"]);

    // Read existing page & 404 on missing
    const pageRes = await app.handle(
      new Request("http://localhost/api/wiki/page?path=decisions/auth.md"),
    );
    expect(pageRes.status).toBe(200);
    expect(((await pageRes.json()) as { frontmatter: { title: string } }).frontmatter.title).toBe(
      "Auth Design",
    );
    expect(
      (await app.handle(new Request("http://localhost/api/wiki/page?path=decisions/missing.md")))
        .status,
    ).toBe(404);

    // Query
    const queryRes = await app.handle(
      new Request("http://localhost/api/wiki/query?text=constant-time"),
    );
    expect(queryRes.status).toBe(200);
    expect(((await queryRes.json()) as { hits: Array<{ path: string }> }).hits[0]?.path).toBe(
      "decisions/auth.md",
    );

    // Backlinks + 404 on missing
    const blRes = await app.handle(
      new Request("http://localhost/api/wiki/backlinks?path=decisions/auth.md"),
    );
    expect(blRes.status).toBe(200);
    expect(
      ((await blRes.json()) as { backlinks: Array<{ path: string }> }).backlinks[0]?.path,
    ).toBe("concepts/security.md");
    expect(
      (await app.handle(new Request("http://localhost/api/wiki/backlinks?path=nope.md"))).status,
    ).toBe(404);

    // Graph + lint
    const graphRes = await app.handle(new Request("http://localhost/api/wiki/graph"));
    expect(graphRes.status).toBe(200);
    const graph = (await graphRes.json()) as {
      nodes: unknown[];
      edges: Array<{ from: string; to: string }>;
    };
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([{ from: "concepts/security.md", to: "decisions/auth.md" }]);

    const lintRes = await app.handle(new Request("http://localhost/api/wiki/lint"));
    expect(lintRes.status).toBe(200);
    const { findings } = (await lintRes.json()) as { findings: Array<{ code: string }> };
    expect(findings.some((f) => f.code === "unsourced")).toBe(true);
  });
});
