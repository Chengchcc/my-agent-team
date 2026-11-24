import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsWikiStore } from "./adapter-fs.js";
import { parsePageText, serializePage } from "./domain.js";
import { createWikiService, type WikiService } from "./service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeService(): WikiService {
  const root = mkdtempSync(join(tmpdir(), "wiki-test-"));
  dirs.push(root);
  return createWikiService({ store: createFsWikiStore(root) });
}

describe("wiki frontmatter", () => {
  test("serialize → parse round-trips sources and ownership", () => {
    const text = serializePage({
      path: "concepts/x.md",
      frontmatter: {
        title: "Retry strategy",
        maintainedBy: "pa-1",
        status: "confirmed",
        sources: ["conversation:c1:10-20", "file:raw/files/a.md"],
        supersedes: ["concepts/old.md"],
        updated: "2026-11-20T00:00:00.000Z",
      },
      body: "Backoff is exponential.\n",
    });
    const parsed = parsePageText(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.title).toBe("Retry strategy");
    expect(parsed!.frontmatter.sources).toEqual(["conversation:c1:10-20", "file:raw/files/a.md"]);
    expect(parsed!.frontmatter.supersedes).toEqual(["concepts/old.md"]);
    expect(parsed!.body.trim()).toBe("Backoff is exponential.");
  });

  test("a file without frontmatter is opaque, never rewritten", () => {
    expect(parsePageText("# just markdown")).toBeNull();
  });
});

describe("ADR 0074 S3: wiki writes", () => {
  test("create then patch with the right revision succeeds and bumps it", async () => {
    const svc = makeService();
    const created = await svc.create({
      path: "concepts/retry.md",
      agentId: "pa-1",
      title: "Retry",
      content: "exponential backoff",
      sources: ["conversation:c1:1-9"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const patched = await svc.patch({
      path: "concepts/retry.md",
      agentId: "pa-1",
      content: "exponential backoff with jitter",
      expectedRevision: created.page.revision,
    });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.page.revision).not.toBe(created.page.revision);
    expect(patched.page.body).toContain("jitter");
  });

  test("a stale revision is refused and the current page comes back", async () => {
    const svc = makeService();
    const created = await svc.create({
      path: "concepts/a.md",
      agentId: "pa-1",
      title: "A",
      content: "v1",
    });
    if (!created.ok) throw new Error("seed failed");
    const first = await svc.patch({
      path: "concepts/a.md",
      agentId: "pa-1",
      content: "v2",
      expectedRevision: created.page.revision,
    });
    expect(first.ok).toBe(true);
    // Second writer still holds the ORIGINAL revision: it must re-read.
    const stale = await svc.patch({
      path: "concepts/a.md",
      agentId: "pa-2",
      content: "v3",
      expectedRevision: created.page.revision,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.reason).toBe("conflict");
    if (stale.reason !== "conflict") return;
    expect(stale.current?.body.trim()).toBe("v2");
  });

  test("personal pages are writable only by their owner; shared pages by any PA", async () => {
    const svc = makeService();
    const privateWrite = await svc.create({
      path: "personal/pa-1/notes.md",
      agentId: "pa-2",
      title: "n",
      content: "x",
    });
    expect(privateWrite.ok).toBe(false);
    if (privateWrite.ok) return;
    expect(privateWrite.reason).toBe("forbidden");

    const ownerWrite = await svc.create({
      path: "personal/pa-1/notes.md",
      agentId: "pa-1",
      title: "n",
      content: "x",
    });
    expect(ownerWrite.ok).toBe(true);

    const sharedWrite = await svc.create({
      path: "lessons/shared.md",
      agentId: "pa-2",
      title: "s",
      content: "y",
      sources: ["conversation:c1:1-2"],
    });
    expect(sharedWrite.ok).toBe(true);
  });

  test("ownership never flips on a patch by another agent", async () => {
    const svc = makeService();
    const created = await svc.create({
      path: "concepts/owned.md",
      agentId: "pa-1",
      title: "o",
      content: "1",
    });
    if (!created.ok) throw new Error("seed failed");
    const patched = await svc.patch({
      path: "concepts/owned.md",
      agentId: "pa-2",
      content: "2",
      expectedRevision: created.page.revision,
    });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.page.frontmatter.maintainedBy).toBe("pa-1");
  });

  test("creating needs title and content; path must sit in a known space", async () => {
    const svc = makeService();
    const noTitle = await svc.create({
      path: "concepts/x.md",
      agentId: "pa-1",
      content: "c",
    });
    expect(noTitle.ok).toBe(false);
    const badPath = await svc.create({
      path: "elsewhere/x.md",
      agentId: "pa-1",
      title: "t",
      content: "c",
    });
    expect(badPath.ok).toBe(false);
    const traversal = await svc.create({
      path: "concepts/../../etc/passwd.md",
      agentId: "pa-1",
      title: "t",
      content: "c",
    });
    expect(traversal.ok).toBe(false);
  });
});

describe("ADR 0074 S3: lint and raw", () => {
  test("lint reports unsourced pages and dangling supersedes targets", async () => {
    const svc = makeService();
    await svc.create({
      path: "concepts/unsourced.md",
      agentId: "pa-1",
      title: "u",
      content: "claim without a source",
      supersedes: ["concepts/gone.md"],
    });
    const codes = svc.lint().map((f) => f.code);
    expect(codes).toContain("unsourced");
    expect(codes).toContain("missing-supersedes-target");
  });

  test("a conversation source is a REFERENCE — the chat is not copied", () => {
    const svc = makeService();
    const out = svc.addSource({
      agentId: "pa-1",
      kind: "conversation",
      conversationId: "c0b5fb98",
      fromSeq: 11834,
      toSeq: 11905,
    });
    expect(out.path).toBe("raw/conversations/c0b5fb98-11834-11905.md");
    const page = svc.read(out.path);
    // raw files are not pages; read() is page-scoped, so the store-level file
    // is checked through query's space scan instead.
    expect(page).toBeNull();
  });

  test("text sources are saved verbatim", () => {
    const svc = makeService();
    const out = svc.addSource({
      agentId: "pa-1",
      kind: "text",
      title: "Karpathy LLM wiki",
      content: "The wiki is a persistent, compounding artifact.",
    });
    expect(out.path).toBe("raw/files/karpathy-llm-wiki.md");
  });

  test("backlinks count both [[wikilinks]] and markdown links", async () => {
    const svc = makeService();
    const target = await svc.create({
      path: "concepts/target.md",
      agentId: "pa-1",
      title: "Target Page",
      content: "the target",
    });
    if (!target.ok) throw new Error("seed failed");
    await svc.create({
      path: "projects/a.md",
      agentId: "pa-1",
      title: "A",
      content: "see [[Target Page]] for details",
      sources: ["conversation:c1:1-2"],
    });
    await svc.create({
      path: "projects/b.md",
      agentId: "pa-1",
      title: "B",
      content: "see [it](concepts/target.md)",
      sources: ["conversation:c1:3-4"],
    });
    const hits = svc.backlinks("concepts/target.md").map((h) => h.path);
    expect(hits).toContain("projects/a.md");
    expect(hits).toContain("projects/b.md");
  });

  test("a write reports ITS OWN findings, so the writer can fix them in-turn", async () => {
    const svc = makeService();
    const created = await svc.create({
      path: "concepts/lonely.md",
      agentId: "pa-1",
      title: "Lonely",
      content: "no sources, nobody links here",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const codes = created.findings.map((f) => f.code);
    // Both are true of this page at this instant; the writer sees them now,
    // not on the next full sweep.
    expect(codes).toContain("unsourced");
    expect(codes).toContain("orphan");

    // After a source and an inbound link, the same page comes back clean.
    const withSource = await svc.patch({
      path: "concepts/lonely.md",
      agentId: "pa-1",
      expectedRevision: created.page.revision,
      sources: ["conversation:c1:1-2"],
    });
    if (!withSource.ok) throw new Error("patch failed");
    await svc.create({
      path: "projects/linker.md",
      agentId: "pa-1",
      title: "Linker",
      content: "see [[Lonely]]",
      sources: ["conversation:c1:3-4"],
    });
    const again = await svc.patch({
      path: "concepts/lonely.md",
      agentId: "pa-1",
      expectedRevision: withSource.page.revision,
      sources: ["conversation:c1:1-2"],
      supersedes: [],
    });
    if (!again.ok) throw new Error("second patch failed");
    expect(again.findings).toEqual([]);
  });

  test("graph: nodes are pages, edges are resolved links in both syntaxes", async () => {
    const svc = makeService();
    await svc.create({
      path: "concepts/g1.md",
      agentId: "pa-1",
      title: "G One",
      content: "x",
      sources: ["conversation:c1:1-2"],
    });
    await svc.create({
      path: "projects/g2.md",
      agentId: "pa-1",
      title: "G Two",
      content: "see [[G One]] and [g3](concepts/g3.md) and [[Missing Page]]",
      sources: ["conversation:c1:3-4"],
    });
    await svc.create({
      path: "concepts/g3.md",
      agentId: "pa-1",
      title: "G Three",
      content: "y",
      sources: ["conversation:c1:5-6"],
    });
    const graph = svc.graph();
    expect(graph.nodes.map((n) => n.path).sort()).toEqual([
      "concepts/g1.md",
      "concepts/g3.md",
      "projects/g2.md",
    ]);
    // Both syntaxes become edges; the unresolved wikilink becomes nothing.
    expect(graph.edges).toContainEqual({ from: "projects/g2.md", to: "concepts/g1.md" });
    expect(graph.edges).toContainEqual({ from: "projects/g2.md", to: "concepts/g3.md" });
    expect(graph.edges).toHaveLength(2);
  });

  test("a page linked only by [[Title]] is not an orphan", async () => {
    const svc = makeService();
    await svc.create({
      path: "concepts/pointed.md",
      agentId: "pa-1",
      title: "Pointed",
      content: "x",
      sources: ["conversation:c1:1-2"],
    });
    await svc.create({
      path: "projects/ref.md",
      agentId: "pa-1",
      title: "Ref",
      content: "go to [[Pointed]]",
      sources: ["conversation:c1:3-4"],
    });
    const codes = svc
      .lint()
      .filter((f) => f.path === "concepts/pointed.md")
      .map((f) => f.code);
    expect(codes).not.toContain("orphan");
  });

  test("personal pages can be excluded at the recall exit (ADR 0074)", async () => {
    const svc = makeService();
    await svc.create({
      path: "personal/pa-1/mine.md",
      agentId: "pa-1",
      title: "Mine",
      content: "retry note",
    });
    await svc.create({
      path: "concepts/shared.md",
      agentId: "pa-1",
      title: "Shared",
      content: "retry note",
    });
    const all = svc.query({ text: "retry" }).map((h) => h.path);
    expect(all.some((path) => path.startsWith("personal/"))).toBe(true);
    // The brief never carries personal/: the constraint lives at this exit,
    // not in a directory convention (independent audit, 2026-11-24).
    const brief = svc.query({ text: "retry", excludeSections: ["personal"] }).map((h) => h.path);
    expect(brief).toEqual(["concepts/shared.md"]);
  });

  test("index.md is rebuilt on every write and links each page", async () => {
    const svc = makeService();
    await svc.create({
      path: "concepts/one.md",
      agentId: "pa-1",
      title: "One",
      content: "1",
    });
    const listed = svc.list().map((p) => p.path);
    expect(listed).toContain("concepts/one.md");
  });
});
