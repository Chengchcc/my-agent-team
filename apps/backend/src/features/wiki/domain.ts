import { createHash } from "node:crypto";

/** ADR 0074 S3: the wiki is a git-backed markdown tree. A page is frontmatter
 *  + body; the frontmatter carries the two facts that make the knowledge
 *  governable — where it came from (`sources`) and who keeps it
 *  (`maintainedBy`). No embeddings, no database: the index file is the search
 *  route at this scale, exactly as the LLM-wiki pattern prescribes. */
export const WIKI_SPACES = ["personal", "projects", "decisions", "concepts", "lessons"] as const;

export type WikiSpace = (typeof WIKI_SPACES)[number];

export type WikiPageStatus = "draft" | "confirmed" | "superseded";

export interface WikiFrontmatter {
  title: string;
  /** The agent that keeps this page. `personal/<agentId>/` pages are writable
   *  only by that agent; shared pages by any PA. */
  maintainedBy: string;
  status: WikiPageStatus;
  /** Where the claims come from: `conversation:<id>:<from>-<to>`,
   *  `file:raw/files/<name>`, or an external URL. */
  sources: readonly string[];
  /** Pages this one replaces (a merge leaves a chain, not a deletion). */
  supersedes: readonly string[];
  updated: string;
}

export interface WikiPage {
  /** Root-relative path, e.g. `concepts/retry-strategy.md`. */
  path: string;
  frontmatter: WikiFrontmatter;
  body: string;
  /** Content hash of the WHOLE file — the CAS token for writes. */
  revision: string;
}

export const FRONTMATTER_FENCE = "---";

/** The file text a page is written as. Kept next to the parser so the two
 *  cannot drift — a serializer that writes what the parser cannot read turns
 *  every write into a corrupt page. */
export function serializePage(page: Omit<WikiPage, "revision">): string {
  const fm = page.frontmatter;
  const lines = [
    FRONTMATTER_FENCE,
    `title: ${fm.title}`,
    `maintainedBy: ${fm.maintainedBy}`,
    `status: ${fm.status}`,
    `updated: ${fm.updated}`,
    ...(fm.sources.length > 0 ? ["sources:", ...fm.sources.map((s) => `  - ${s}`)] : []),
    ...(fm.supersedes.length > 0 ? ["supersedes:", ...fm.supersedes.map((s) => `  - ${s}`)] : []),
    FRONTMATTER_FENCE,
    "",
    page.body.replace(/\s+$/, ""),
    "",
  ];
  return lines.join("\n");
}

interface ParsedFile {
  frontmatter: WikiFrontmatter;
  body: string;
}

/** Parse `---` frontmatter with the small subset we write: `key: value` and
 *  block lists (`key:` then `  - item`). Anything unreadable yields null and
 *  the caller treats the file as opaque — a page whose metadata cannot be
 *  trusted must not be silently rewritten. */
export function parsePageText(text: string): ParsedFile | null {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FRONTMATTER_FENCE}\n`)) return null;
  const end = normalized.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length);
  if (end < 0) return null;
  const head = normalized.slice(FRONTMATTER_FENCE.length + 1, end);
  const body = normalized.slice(end + FRONTMATTER_FENCE.length + 2);

  const scalars = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let currentList: string[] | null = null;
  for (const rawLine of head.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    const item = /^\s{2}-\s+(.*)$/.exec(line);
    if (item && currentList) {
      currentList.push(item[1]!.trim());
      continue;
    }
    const pair = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!pair) return null;
    const key = pair[1]!;
    const value = pair[2]!.trim();
    if (value === "") {
      currentList = [];
      lists.set(key, currentList);
      continue;
    }
    currentList = null;
    scalars.set(key, value);
  }

  const title = scalars.get("title");
  const maintainedBy = scalars.get("maintainedBy");
  const updated = scalars.get("updated");
  if (!title || !maintainedBy || !updated) return null;
  const rawStatus = scalars.get("status");
  const status: WikiPageStatus =
    rawStatus === "confirmed" || rawStatus === "superseded" ? rawStatus : "draft";
  return {
    frontmatter: {
      title,
      maintainedBy,
      status,
      sources: lists.get("sources") ?? [],
      supersedes: lists.get("supersedes") ?? [],
      updated,
    },
    body,
  };
}

/** The CAS token. Computed where the text is read (one site) so a page can
 *  never carry a revision that does not match its own bytes. */
export function revisionOfText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export interface WikiLintFinding {
  code: "unsourced" | "orphan" | "missing-supersedes-target" | "unknown-space";
  path: string;
  detail: string;
}

/** Path rules: spaces are the first segment, then free nesting. `personal/`
 *  is scoped to ONE agent — the segment after it must be that agent's id, so
 *  the guard is a path convention anyone can audit, not a hidden policy. */
export function validatePagePath(path: string): string | null {
  if (path.includes("..") || path.startsWith("/") || path.includes("\\")) {
    return "path must be relative and must not contain '..'";
  }
  if (!path.endsWith(".md")) return "page path must end with .md";
  const segments = path.split("/");
  const space = segments[0];
  if (!WIKI_SPACES.includes(space as WikiSpace)) {
    return `page path must start with one of: ${WIKI_SPACES.join(", ")}`;
  }
  if (space === "personal" && segments.length < 3) {
    return "personal pages live at personal/<agentId>/<name>.md";
  }
  return null;
}
