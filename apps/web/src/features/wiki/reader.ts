/** What the reading view derives from a page body: the table of contents, the lead that becomes
 *  the summary, and the footnote markers that point at the sources list. All string work, so
 *  the renderer keeps one markdown path (and one sanitizer: raw HTML is never rendered). */

export interface TocHeading {
  level: number;
  text: string;
  id: string;
  /** The line of the rendered markdown the heading starts on (1-based). The renderer gives the
   *  heading on that line the same id, so the two cannot disagree about an anchor. */
  line: number;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** Anything that opens a block other than a paragraph. */
const BLOCK_START = /^ {0,3}(#{1,6}\s|>|[-*+]\s|\d{1,9}[.)]\s|\|)/;
const WIKILINK = /!{0,1}\[\[([^\]|]+)(?:\|([^\]]+)){0,1}\]\]/g;
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const MARKERS = /(\*\*|__|\*|_|~~|`)/g;
const FOOTNOTE = /(?<!\[)\[(\d+)\](?!\]|\()/g;

/** A fragment a person can read in a URL: lowercase, letters and digits kept, spaces as dashes. */
function slugify(text: string): string {
  const lowered = text.toLowerCase().normalize("NFKD");
  const kept = lowered.replace(/[^\p{L}\p{N}\s-]/gu, "").trim();
  const slug = kept.replace(/\s+/g, "-");
  if (slug === "") return "section";
  return slug;
}

function labelOf(target: string, label: string | undefined): string {
  if (label !== undefined && label.trim() !== "") return label;
  return target;
}

/** Markdown inline syntax removed: what a heading or a lead says, as plain text. */
export function stripInline(markdown: string): string {
  const withoutImages = markdown.replace(IMAGE, "$1");
  const withoutWikilinks = withoutImages.replace(WIKILINK, (_whole, target, label) =>
    labelOf(target, label),
  );
  const withoutLinks = withoutWikilinks.replace(LINK, "$1");
  const withoutMarkers = withoutLinks.replace(MARKERS, "");
  return withoutMarkers.trim();
}

/** Every heading outside a code fence, with an id unique within the page. */
export function extractToc(markdown: string): TocHeading[] {
  const headings: TocHeading[] = [];
  const used = new Map<string, number>();
  let fenced = false;
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = HEADING.exec(line);
    if (match === null) continue;
    const text = stripInline(match[2] ?? "");
    const base = slugify(text);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const id = seen === 0 ? base : `${base}-${seen + 1}`;
    const hashes = match[1]?.length;
    headings.push({ level: hashes ?? 1, text, id, line: index + 1 });
  }
  return headings;
}

/** The first paragraph of a body and everything after it. The lead is shown once, as the
 *  summary; a body that opens with anything else has no lead. */
export function splitLead(body: string): { lead: string; rest: string } {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  while (start < lines.length && (lines[start] ?? "").trim() === "") start += 1;
  const first = lines[start] ?? "";
  const opensParagraph = start < lines.length && !BLOCK_START.test(first) && !FENCE.test(first);
  if (!opensParagraph) {
    return { lead: "", rest: body };
  }
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    const stops = line.trim() === "" || BLOCK_START.test(line) || FENCE.test(line);
    if (stops) break;
    end += 1;
  }
  const lead = lines.slice(start, end).join("\n");
  const rest = [...lines.slice(0, start), ...lines.slice(end)].join("\n");
  return { lead, rest };
}

/** The lead as one line of plain text, for the index. */
export function leadText(body: string): string {
  const parts = splitLead(body);
  const plain = stripInline(parts.lead).replace(/\s+/g, " ").trim();
  if (plain.length <= 200) return plain;
  return `${plain.slice(0, 199).trimEnd()}…`;
}

/** `[1]` in a body becomes a link to the first source, when there is one. A wikilink (`[[1]]`)
 *  and a markdown link (`[1](…)`) are left alone. */
export function linkFootnotes(markdown: string, sourceCount: number): string {
  return markdown.replace(FOOTNOTE, (whole: string, numberText: string) => {
    const number = Number(numberText);
    if (number < 1 || number > sourceCount) return whole;
    return `[[${number}]](#wiki-source-${number})`;
  });
}

export interface SourceRef {
  kind: "conversation" | "file" | "link" | "text";
  /** A word for what the source is, translated by the page. */
  label: string;
  /** The reference as shown. */
  reference: string;
  /** Where it leads inside the console or on the web; null when it is only a name. */
  href: string | null;
}

const CONVERSATION_SOURCE = /^conversation:([^:]+):(\d+)-(\d+)$/;
const FILE_SOURCE = /^file:(.+)$/;
const ADDRESS_SOURCE = /^https?:\/\/\S+$/;

/** A `sources` entry: `conversation:<id>:<from>-<to>`, `file:raw/files/<name>`, an address, or
 *  anything else a person wrote. Nothing is fetched to describe it. */
export function describeSource(source: string): SourceRef {
  const conversation = CONVERSATION_SOURCE.exec(source);
  if (conversation !== null) {
    const id = conversation[1] ?? "";
    const from = conversation[2] ?? "";
    const to = conversation[3] ?? "";
    return {
      kind: "conversation",
      label: "Conversation",
      reference: `${id} · messages ${from}–${to}`,
      href: `/chat/${encodeURIComponent(id)}?at=${from}`,
    };
  }
  const file = FILE_SOURCE.exec(source);
  if (file !== null) {
    return { kind: "file", label: "File", reference: file[1] ?? source, href: null };
  }
  const isAddress = ADDRESS_SOURCE.test(source);
  if (isAddress) return { kind: "link", label: "Link", reference: source, href: source };
  return { kind: "text", label: "Source", reference: source, href: null };
}
