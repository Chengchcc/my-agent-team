/** Product-owned conversation titles.
 *
 *  ADR 0040 leaves every harness behind one ACP rail, and a title is a product
 *  fact, not a harness one. oma used to generate it — the title rode the oma RPC
 *  rail's terminal result, which `f1dd744e` deleted, and under ACP the harness
 *  only writes its own session file. claude/omp/pi never produced one at all, so
 *  a harness-private title would leave those conversations permanently untitled.
 *
 *  The title is derived here instead, from the turn that started the
 *  conversation. oma's own generator is switched off for product-spawned runs
 *  (OMA_TITLE_ENABLED=0), which stops it paying a model call per turn for a
 *  title nothing can read.
 *
 *  ponytail: text heuristic, no model call — the first user message is almost
 *  always a usable title. Upgrade path if quality ever matters: one small model
 *  call, the shape `generateTitleAndSummary` already uses in oma. */
import { deserializeLedgerContent } from "@chengchenccc/message";
import { REMINDER_BANNER_PREFIX } from "../reminder/index.js";

const MAX_LENGTH = 60;

/** The `[file L1-2] ` prefix `describeAnchor` renders for an anchored comment
 *  (see artifact/anchor.ts): filename plus a lines/rows/region/moment spot.
 *  Anchored rather than "any bracket", so a message that legitimately starts
 *  with "[URGENT]" keeps its own words. */
const ANCHOR_PREFIX = /^\[[^\]\n]*(?: L\d| rows \d| @\d+:\d+| \([^\]\n]+\))[^\]\n]*]\s*/;

/** Strip the wrappers the product puts in front of a message. Without this a
 *  comment on report.md titles its conversation "[report.md L40-45] …", and a
 *  delivered reminder titles it with the banner instead of the reminder. */
function stripProductPrefixes(text: string): string {
  return text.replace(ANCHOR_PREFIX, "").replace(REMINDER_BANNER_PREFIX, "");
}

/** The conversation's first user turn: the earliest non-undone message row
 *  authored by the user. Ledger rows carry their revision as a serialized
 *  string on the live path and as a parsed object on the read path, so both are
 *  accepted (the codec is the one place that knows the difference). */
export function firstUserText(
  entries: readonly { readonly content?: unknown; readonly undone?: boolean }[],
): string | null {
  for (const entry of entries) {
    if (entry.undone === true) continue;
    const parsed = deserializeLedgerContent(
      typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content),
    );
    if ("role" in parsed && parsed.role === "user" && typeof parsed.text === "string") {
      if (parsed.text.trim() !== "") return parsed.text;
    }
  }
  return null;
}

/** The conversation title for a turn's text, or null when there is nothing
 *  usable to build one from. Whitespace collapses (a multi-line prompt must not
 *  produce a multi-line sidebar entry) and an over-long one is cut at a word
 *  boundary. */
export function deriveConversationTitle(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const flat = stripProductPrefixes(text).replace(/\s+/gu, " ").trim();
  if (flat === "") return null;
  if (flat.length <= MAX_LENGTH) return flat;
  const cut = flat.slice(0, MAX_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  const body = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return `${body}…`;
}
