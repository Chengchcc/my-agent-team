import { encodeWikiPath } from "./paths";

/** Obsidian's link syntax, resolved against the page list we already fetched:
 *
 *    [[Concepts/Retry]]        → a link to that page
 *    [[Concepts/Retry|retry]]  → same, labelled "retry"
 *    ![[Concepts/Retry]]       → an "embed" chip (we do not transclude; we
 *                                open the page — a copy would drift)
 *
 * An unresolved [[Name]] renders as plain text: there is no page to open, and
 * the wiki has no search box of its own (search is Ctrl+K). A dead link is
 * worse than a quiet one.
 *
 * Deliberately a string transform, not a remark plugin: the output is ordinary
 * markdown, so the renderer keeps one code path (and one sanitizer).
 */
export function linkifyWikilinks(body: string, pathByTitle: ReadonlyMap<string, string>): string {
  const resolve = (target: string): { href: string | null; label: string } => {
    const title = target.trim();
    const path = pathByTitle.get(title) ?? (title.endsWith(".md") ? title : null);
    if (path !== null) return { href: `/wiki/page?path=${encodeWikiPath(path)}`, label: title };
    return { href: null, label: title };
  };

  // Embeds first: `![[x]]` must not be eaten by the plain-wikilink rule.
  const withEmbeds = body.replace(
    /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_all, target: string, label?: string) => {
      const hit = resolve(target);
      if (hit.href === null) return label ?? hit.label;
      return `[${label ?? hit.label} ↗](${hit.href})`;
    },
  );

  return withEmbeds.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_all, target: string, label?: string) => {
      const hit = resolve(target);
      if (hit.href === null) return label ?? hit.label;
      return `[${label ?? hit.label}](${hit.href})`;
    },
  );
}

/** The title → path map the resolver needs. Titles are not unique across
 *  spaces; the first one wins, which matches how the index lists them. */
export function titleIndex(
  pages: ReadonlyArray<{ path: string; title: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const page of pages) {
    if (!map.has(page.title)) map.set(page.title, page.path);
  }
  return map;
}
