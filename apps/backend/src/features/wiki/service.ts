import type { WikiStore } from "./adapter-fs.js";
import {
  parsePageText,
  revisionOfText,
  serializePage,
  validatePagePath,
  type WikiFrontmatter,
  type WikiLintFinding,
  type WikiPage,
  type WikiPageStatus,
} from "./domain.js";

export interface WikiWriteInput {
  path: string;
  /** The calling agent — ownership and the personal-space guard. */
  agentId: string;
  title?: string;
  /** Full body replacement (without frontmatter). */
  content?: string;
  status?: WikiPageStatus;
  sources?: readonly string[];
  supersedes?: readonly string[];
  /** The revision the caller read. `null` means "this page must not exist". */
  expectedRevision: string | null;
}

export type WikiWriteResult =
  | {
      ok: true;
      page: WikiPage;
      /** Findings about the page just written, so the writer can fix them in
       *  the same turn (an unsourced claim is cheapest to fix now). */
      findings: WikiLintFinding[];
    }
  | { ok: false; reason: "conflict"; current: WikiPage | null }
  | { ok: false; reason: "invalid" | "forbidden"; detail: string };

export interface WikiSearchHit {
  path: string;
  title: string;
  status: WikiPageStatus;
  maintainedBy: string;
  snippet: string;
}

export interface WikiSourceInput {
  agentId: string;
  kind: "conversation" | "text";
  /** For `conversation`: the ledger range, by reference — the chat itself is
   *  never copied into the wiki. */
  conversationId?: string;
  fromSeq?: number;
  toSeq?: number;
  /** For `text`: the material, saved verbatim. */
  title?: string;
  content?: string;
}

export interface WikiGraphNode {
  path: string;
  title: string;
  status: WikiPageStatus;
  maintainedBy: string;
  /** First path segment: personal | projects | decisions | … */
  space: string;
}

export interface WikiGraph {
  nodes: WikiGraphNode[];
  /** `to` is always an EXISTING page: a link to nothing is not an edge. */
  edges: Array<{ from: string; to: string }>;
}

export interface WikiBacklink {
  path: string;
  title: string;
  /** The sentence around the link — enough to judge relevance without opening
   *  the page. */
  context: string;
}

export interface WikiService {
  list(): Array<{ path: string; title: string; status: WikiPageStatus; maintainedBy: string }>;
  /** ADR 0074: who points here. Both `[[Title]]` wikilinks and markdown
   *  `](path)` links count — two syntaxes, one graph. */
  backlinks(path: string): WikiBacklink[];
  /** The whole link graph, for the Obsidian-style view. */
  graph(): WikiGraph;
  read(path: string): WikiPage | null;
  query(input: { text?: string; limit?: number }): WikiSearchHit[];
  create(input: Omit<WikiWriteInput, "expectedRevision">): Promise<WikiWriteResult>;
  patch(input: WikiWriteInput): Promise<WikiWriteResult>;
  lint(): WikiLintFinding[];
  addSource(input: WikiSourceInput): { path: string };
}

/** Every link target a body points at, in both syntaxes, resolved to page
 *  paths when possible. Unresolved wikilinks are dropped: an edge to a page
 *  that does not exist would draw a node nobody can open. */
function linkTargetsOf(
  body: string,
  pathByTitle: ReadonlyMap<string, string>,
  existing: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const target = match[1]!.trim();
    const path = pathByTitle.get(target);
    if (path !== undefined) out.push(path);
  }
  for (const match of body.matchAll(/\]\(([^)\s]+\.md)\)/g)) {
    const path = match[1]!;
    if (existing.has(path)) out.push(path);
  }
  return out;
}

/** Position of the first link to any of `names` in `body`, or -1. Both
 *  Obsidian wikilinks and plain markdown links count: the graph should not
 *  depend on which syntax the writer happened to use. */
function findLinkAt(body: string, names: readonly string[]): number {
  let best = -1;
  for (const name of names) {
    for (const needle of [`[[${name}]]`, `[[${name}|`, `](${name})`]) {
      const at = body.indexOf(needle);
      if (at < 0) continue;
      if (best < 0 || at < best) best = at;
    }
  }
  return best;
}

const INDEX_PATH = "index.md";
const LOG_PATH = "log.md";

export function createWikiService(deps: { store: WikiStore; now?: () => string }): WikiService {
  const now = deps.now ?? (() => new Date().toISOString());
  /** Per-page serialization. Two runs (or two PAs) touching one page queue
   *  here; the CAS above them refuses the second write if it read stale. */
  const chains = new Map<string, Promise<unknown>>();

  // The third layer of the LLM-wiki pattern: the conventions live IN the
  // repository, next to the pages they govern, so any reader (or the next
  // session) finds them without being told.
  if (deps.store.read("index.md") === null) {
    deps.store.write(
      "index.md",
      "# Wiki index\n\nGenerated on every write — empty until the first page exists.\n",
      { author: "wiki", summary: "wiki: seed index" },
    );
  }
  if (deps.store.read("schema.md") === null) {
    deps.store.write(
      "schema.md",
      [
        "# Wiki schema",
        "",
        "How this wiki is written. The pages are markdown; git is the history.",
        "",
        "## Layers",
        "",
        "- `raw/` — sources, written by the ingest path only. `raw/conversations/` records",
        "  ledger RANGES by reference (the chat is never copied); `raw/files/` holds material",
        "  a person provided, verbatim.",
        "- the pages — compiled knowledge: summaries, decisions, concepts, lessons.",
        "- this file — the conventions.",
        "",
        "## Writing",
        "",
        "- Every page frontmatter: `title`, `maintainedBy`, `status` (draft|confirmed|superseded),",
        "  `updated`, `sources`, `supersedes`.",
        "- Cite something in `sources` for every claim. A page with no source is a rumour;",
        "  `wiki_lint` says so.",
        "- `personal/<agentId>/` is writable ONLY by that agent. Shared spaces",
        "  (`projects/`, `decisions/`, `concepts/`, `lessons/`) are writable by any assistant.",
        "- Patches carry the revision they read (`expected_revision`). A stale revision is",
        "  refused: re-read, merge, retry. Never overwrite a human edit.",
        "",
        "## Operations",
        "",
        "- ingest: read a source, write or update the pages it touches, keep the source cited.",
        "- query: search titles and bodies here FIRST; go back to `raw/` when the compiled",
        "  answer is missing or when the exact wording matters.",
        "- lint: unsourced pages, orphan pages, supersedes targets that do not exist.",
        "",
        "Answers worth keeping are filed back as pages — that is how this compounding works.",
        "",
      ].join("\n"),
      { author: "wiki", summary: "wiki: seed schema" },
    );
  }

  function withPageLock<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(path) ?? Promise.resolve();
    const next = previous.then(task, task);
    chains.set(
      path,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  function readPage(path: string): WikiPage | null {
    const text = deps.store.read(path);
    if (text === null) return null;
    const parsed = parsePageText(text);
    if (parsed === null) return null;
    return {
      path,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      revision: revisionOfText(text),
    };
  }

  function allPagePaths(): string[] {
    const paths: string[] = [];
    for (const dir of ["personal", "projects", "decisions", "concepts", "lessons"]) {
      for (const rel of deps.store.list(dir)) {
        if (rel.endsWith(".md")) paths.push(rel);
      }
    }
    return paths.sort();
  }

  function allPages(): WikiPage[] {
    const pages: WikiPage[] = [];
    for (const path of allPagePaths()) {
      const page = readPage(path);
      if (page) pages.push(page);
    }
    return pages;
  }

  /** Findings that concern ONE page. Shared by the full sweep and by the
   *  write path: the same predicate in both places, or the nudge and the
   *  report disagree — which teaches people to ignore both. */
  function findingsFor(page: WikiPage, pages: readonly WikiPage[]): WikiLintFinding[] {
    const out: WikiLintFinding[] = [];
    if (page.frontmatter.sources.length === 0) {
      out.push({
        code: "unsourced",
        path: page.path,
        detail: "no sources: a claim nobody can trace is a rumour",
      });
    }
    const linked = pages.some(
      (other) =>
        other.path !== page.path &&
        findLinkAt(other.body, [page.path, page.frontmatter.title]) >= 0,
    );
    if (!linked) {
      out.push({
        code: "orphan",
        path: page.path,
        detail: "no page links here — index.md does not count",
      });
    }
    const existing = new Set(pages.map((p) => p.path));
    for (const target of page.frontmatter.supersedes) {
      if (!existing.has(target)) {
        out.push({
          code: "missing-supersedes-target",
          path: page.path,
          detail: `supersedes ${target}, which does not exist`,
        });
      }
    }
    return out;
  }

  function rebuildIndex(pages: readonly WikiPage[]): void {
    const lines = [
      "# Wiki index",
      "",
      "Generated on every write — do not edit by hand; edit the page.",
      "",
      ...pages.map(
        (p) =>
          `- [${p.frontmatter.title}](${p.path}) — ${p.frontmatter.status} · ${p.frontmatter.maintainedBy}`,
      ),
      "",
    ];
    deps.store.write(INDEX_PATH, lines.join("\n"), {
      author: "wiki",
      summary: "wiki: rebuild index",
    });
  }

  function appendLog(summary: string, author: string): void {
    const stamp = now();
    const entry = `## [${stamp}] ${summary} — ${author}\n`;
    const current = deps.store.read(LOG_PATH) ?? "# Wiki log\n\n";
    deps.store.write(LOG_PATH, `${current.replace(/\s+$/, "")}\n\n${entry}`, {
      author: "wiki",
      summary: `wiki: log ${summary}`,
    });
  }

  async function writePage(input: WikiWriteInput): Promise<WikiWriteResult> {
    const pathError = validatePagePath(input.path);
    if (pathError !== null) return { ok: false, reason: "invalid", detail: pathError };
    const segments = input.path.split("/");
    if (segments[0] === "personal") {
      // Personal knowledge is written by its owner only; everyone may read.
      // The path convention makes the rule auditable instead of hidden.
      if (segments[1] !== input.agentId) {
        return {
          ok: false,
          reason: "forbidden",
          detail: `personal pages are writable only by their owner (${segments[1]})`,
        };
      }
    }
    return withPageLock(input.path, async () => {
      const current = readPage(input.path);
      const expected = input.expectedRevision;
      const currentRevision = current === null ? null : current.revision;
      if (expected !== currentRevision) {
        return { ok: false, reason: "conflict", current };
      }
      const creating = current === null;
      const hasTitle = input.title !== undefined;
      const hasContent = input.content !== undefined;
      const missingForCreate = !hasTitle || !hasContent;
      if (creating && missingForCreate) {
        return { ok: false, reason: "invalid", detail: "creating a page needs title and content" };
      }

      let status: WikiPageStatus = input.status ?? "draft";
      if (current !== null && input.status === undefined) {
        status = current.frontmatter.status;
      }
      const sources = new Set<string>();
      for (const s of current?.frontmatter.sources ?? []) sources.add(s);
      for (const s of input.sources ?? []) sources.add(s);
      const supersedes = new Set<string>();
      for (const s of current?.frontmatter.supersedes ?? []) supersedes.add(s);
      for (const s of input.supersedes ?? []) supersedes.add(s);

      // Ownership never flips on a patch: the agent that took the page keeps
      // it. A new page is owned by its creator.
      const maintainedBy = current === null ? input.agentId : current.frontmatter.maintainedBy;
      const title = input.title ?? current?.frontmatter.title ?? "";
      const body = input.content ?? current?.body ?? "";
      const frontmatter: WikiFrontmatter = {
        title,
        maintainedBy,
        status,
        sources: [...sources],
        supersedes: [...supersedes],
        updated: now(),
      };
      deps.store.write(input.path, serializePage({ path: input.path, frontmatter, body }), {
        author: input.agentId,
        summary: `${creating ? "wiki: create" : "wiki: update"} ${input.path}`,
      });
      appendLog(`${creating ? "create" : "update"} | ${input.path}`, input.agentId);
      rebuildIndex(allPages());
      const written = readPage(input.path);
      if (written === null) {
        return {
          ok: false,
          reason: "invalid",
          detail: "page was written but could not be read back",
        };
      }
      return { ok: true, page: written, findings: findingsFor(written, allPages()) };
    });
  }

  return {
    list() {
      return allPages().map((p) => ({
        path: p.path,
        title: p.frontmatter.title,
        status: p.frontmatter.status,
        maintainedBy: p.frontmatter.maintainedBy,
      }));
    },
    backlinks(path) {
      const pages = allPages();
      const target = pages.find((p) => p.path === path);
      const names = target === undefined ? [path] : [path, target.frontmatter.title];
      const out: WikiBacklink[] = [];
      for (const other of pages) {
        if (other.path === path) continue;
        const at = findLinkAt(other.body, names);
        if (at < 0) continue;
        const from = Math.max(0, at - 80);
        out.push({
          path: other.path,
          title: other.frontmatter.title,
          context: other.body
            .slice(from, at + 120)
            .replace(/\s+/g, " ")
            .trim(),
        });
      }
      return out;
    },
    graph() {
      const pages = allPages();
      const existing = new Set(pages.map((p) => p.path));
      const pathByTitle = new Map<string, string>();
      for (const page of pages) {
        if (!pathByTitle.has(page.frontmatter.title))
          pathByTitle.set(page.frontmatter.title, page.path);
      }
      const nodes: WikiGraphNode[] = pages.map((p) => ({
        path: p.path,
        title: p.frontmatter.title,
        status: p.frontmatter.status,
        maintainedBy: p.frontmatter.maintainedBy,
        space: p.path.split("/")[0] ?? "",
      }));
      const edges: Array<{ from: string; to: string }> = [];
      for (const page of pages) {
        for (const to of linkTargetsOf(page.body, pathByTitle, existing)) {
          if (to !== page.path) edges.push({ from: page.path, to });
        }
      }
      return { nodes, edges };
    },
    read(path) {
      if (validatePagePath(path) !== null) return null;
      return readPage(path);
    },
    query(input) {
      const limit = input.limit ?? 20;
      const needle = (input.text ?? "").toLowerCase().trim();
      const pages = allPages();
      const hits: WikiSearchHit[] = [];
      for (const page of pages) {
        if (needle !== "") {
          const haystack = `${page.frontmatter.title}\n${page.body}`.toLowerCase();
          if (!haystack.includes(needle)) continue;
        }
        const flat = page.body.replace(/\s+/g, " ").trim();
        hits.push({
          path: page.path,
          title: page.frontmatter.title,
          status: page.frontmatter.status,
          maintainedBy: page.frontmatter.maintainedBy,
          snippet: flat.slice(0, 240),
        });
        if (hits.length >= limit) break;
      }
      return hits;
    },
    create(input) {
      return writePage({ ...input, expectedRevision: null });
    },
    patch(input) {
      return writePage(input);
    },
    lint() {
      const pages = allPages();
      const findings: WikiLintFinding[] = [];
      for (const page of pages) findings.push(...findingsFor(page, pages));
      return findings;
    },
    addSource(input) {
      const stamp = now();
      if (input.kind === "text") {
        const slug = (input.title ?? "source")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 60);
        const path = `raw/files/${slug || "source"}.md`;
        const content = `<!-- saved by ${input.agentId} at ${stamp} -->\n\n${input.content ?? ""}\n`;
        deps.store.write(path, content, {
          author: input.agentId,
          summary: `wiki: raw ${path}`,
        });
        appendLog(`raw | ${path}`, input.agentId);
        return { path };
      }
      const conversationId = input.conversationId ?? "unknown";
      const from = input.fromSeq ?? 0;
      const to = input.toSeq ?? 0;
      // By reference, deliberately: the ledger is the source of truth and a
      // copy would drift from it.
      const path = `raw/conversations/${conversationId}-${from}-${to}.md`;
      const content = [
        `<!-- saved by ${input.agentId} at ${stamp} -->`,
        "",
        `conversation: ${conversationId}`,
        `range: ${from}-${to}`,
        "",
        "The messages live in the ledger; read them there by seq.",
        "",
      ].join("\n");
      deps.store.write(path, content, { author: input.agentId, summary: `wiki: raw ${path}` });
      appendLog(`raw | ${path}`, input.agentId);
      return { path };
    },
  };
}
