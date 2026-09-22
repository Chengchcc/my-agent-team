/** Knowledge-file frontmatter (ADR 0022, progressive loading).
 *
 *  A knowledge pack is a directory of arbitrary files; the only structured
 *  contract is an optional frontmatter block at the top of a file:
 *
 *  ---
 *  title: Run lifecycle
 *  description: One line saying what this file answers, for the injected index
 *  tags: [runs, backend]
 *  hide: true          # readable and searchable, but not listed in the index
 *
 *  ---
 *
 *  The purpose is progressive loading: the index injected into every run
 *  carries title/description/tags only, and the body is fetched on demand
 *  with knowledge_read / knowledge_search. Files without frontmatter still
 *  work — they are listed by path alone.
 *
 *  Deliberately a line parser, not a YAML dependency: the fields are flat
 *  scalars and lists, and a pack authored by hand or by a model should never
 *  fail to load because of a YAML edge case. Unknown keys are ignored. */

export interface KnowledgeFrontmatter {
  /** Frontmatter `title`; empty when absent. */
  readonly title: string;
  /** Frontmatter `description`: what this file answers, shown in the index. */
  readonly description: string;
  /** Frontmatter `tags`, comma or bracket list, lowercased. */
  readonly tags: readonly string[];
  /** Frontmatter `hide: true`: keep out of the injected index only. */
  readonly hide: boolean;
  /** The file text with the frontmatter block removed. */
  readonly body: string;
}

const EMPTY: Omit<KnowledgeFrontmatter, "body"> = {
  title: "",
  description: "",
  tags: [],
  hide: false,
};

/** Split a leading `---` block from the body and read the flat fields we
 *  define. No frontmatter, or an unterminated one, = whole text is the body. */
export function parseKnowledgeFrontmatter(text: string): KnowledgeFrontmatter {
  const match = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { ...EMPTY, body: text };

  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    // Strip a trailing comment only when it is clearly outside the value.
    fields.set(
      key,
      line
        .slice(idx + 1)
        .trim()
        .replace(/\s+#.*$/, ""),
    );
  }

  const list = (raw: string | undefined): string[] => {
    if (!raw) return [];
    return raw
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((t) =>
        t
          .trim()
          .replace(/^["']|["']$/g, "")
          .toLowerCase(),
      )
      .filter((t) => t !== "");
  };

  const scalar = (raw: string | undefined): string =>
    (raw ?? "").replace(/^["']|["']$/g, "").trim();

  return {
    title: scalar(fields.get("title")),
    description: scalar(fields.get("description")),
    tags: list(fields.get("tags")),
    hide: /^(true|yes|1)$/i.test(fields.get("hide") ?? ""),
    body: text.slice(match[0].length),
  };
}
