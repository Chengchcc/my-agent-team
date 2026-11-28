/** Cue extraction for recall (ADR 0055/0058).
 *
 *  Deliberately not a model decision: asking a model "do you need to recall?"
 *  reproduces the failure it prevents — the model does not know something is
 *  missing, but a pronoun or reference cue is knowable in a regex. */
export interface Cues {
  /** Human-readable reasons the recall was triggered. */
  readonly cues: readonly string[];
  /** Verbatim pointers worth searching as-is. */
  readonly identifiers: readonly string[];
  /** The query handed to keyword search (identifiers, else the text itself). */
  readonly query: string;
}

const ZH_PRONOUN_CUES: readonly string[] = [
  "这个",
  "那个",
  "那些",
  "这些",
  "它",
  "它们",
  "刚才",
  "上次",
  "上回",
  "之前",
  "前面",
  "上面",
  "说过",
  "提过",
  "还是",
];

/** English cues require word boundaries so ordinary words like "write", "with",
 *  "edit", "commit", "history", or "status" do not falsely match "it"/"this"/"that". */
const EN_PRONOUN_CUES: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: "this", re: /\bthis\b/i },
  { label: "that", re: /\bthat\b/i },
  { label: "those", re: /\bthose\b/i },
  { label: "it", re: /\bit\b/i },
  { label: "earlier", re: /\bearlier\b/i },
  { label: "previously", re: /\bpreviously\b/i },
  { label: "last time", re: /\blast time\b/i },
  { label: "the same", re: /\bthe same\b/i },
];

/** Things that are already a pointer, so they are worth searching verbatim:
 *  issue/PR numbers, ledger refs, file paths, error codes, version tags. */
const IDENTIFIERS: ReadonlyArray<RegExp> = [
  /#[0-9]{1,6}\b/g,
  /\bseq:\d+\b/g,
  /\b[\w./-]+\.(?:ts|tsx|js|json|md|yml|yaml|sql|py)\b/g,
  /\b[A-Z][A-Z0-9_]{3,}\b/g,
  /\bv?\d+\.\d+(?:\.\d+)?\b/g,
];

const MAX_QUERY_CHARS = 200;

export function extractCues(text: string): Cues {
  const cues: string[] = [];
  for (const cue of ZH_PRONOUN_CUES) {
    if (text.includes(cue)) cues.push(cue);
  }
  for (const { label, re } of EN_PRONOUN_CUES) {
    if (re.test(text)) cues.push(label);
  }
  const identifiers = new Set<string>();
  for (const pattern of IDENTIFIERS) {
    for (const match of text.matchAll(pattern)) identifiers.add(match[0]);
  }
  const ids = [...identifiers];
  // Identifiers are precise; the sentence is the fallback query. Both go
  // through the same segmenter downstream, so a long sentence is not a cost
  // problem — but keeping it bounded keeps the search predictable.
  const query = (ids.length > 0 ? ids.join(" ") : text).trim().slice(0, MAX_QUERY_CHARS);
  return {
    cues: cues.length > 0 ? cues : ids.length > 0 ? ["identifier"] : [],
    identifiers: ids,
    query,
  };
}

/** Should this message consult memory at all? No cue and no identifier means
 *  the message stands on its own — skipping the lookup keeps the common case
 *  free. */
export function needsRecall(cues: Cues): boolean {
  return cues.cues.length > 0;
}
