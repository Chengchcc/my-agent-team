/**
 * How a compaction summarization request is shaped.
 *
 * The summarizer used to receive the raw messages with one generic system line,
 * which invites three failure modes this module closes:
 *
 * - the model continues the conversation instead of summarizing it (nothing
 *   marks the transcript as data),
 * - tool semantics are lost because the blocks are never rendered as text,
 * - thinking blocks and images leak into the summary input in shapes the
 *   summarizer model has no reason to see.
 *
 * Kept separate from `compaction.ts` so the request shape is testable without a
 * store, a model, or a Run.
 */
import type { Message } from "@chengchenccc/message";

/** System prompt for every summarization call. Tuned for a coding agent: the
 *  summary must survive being the ONLY thing a later turn sees of this region,
 *  so identity (paths, commands, ids) and rejected options matter more than
 *  narrative flow. */
export const SUMMARIZATION_SYSTEM_PROMPT = [
  "You compress a coding agent's conversation so the work can continue after the older",
  "messages are dropped from context. Write one summary a later turn can rely on without",
  "seeing the originals.",
  "",
  "Keep, exactly: decisions with their reason and anything explicitly rejected; the current",
  "state (what is implemented, what is verified, what is still open); exact identifiers such",
  "as file paths, commands, commit or branch ids and error strings; user preferences and",
  "constraints stated in the conversation.",
  "Drop: greetings, tool chatter, restatements, and anything later work supersedes.",
  "",
  "Write plain prose in the conversation's own language (usually Chinese). No preamble, no",
  "headings, no code fences.",
].join("\n");

const FIRST_TASK = "Summarize the conversation inside <conversation>.";

/** A compaction cut can land mid-turn, and it usually does: the trigger fires
 *  the moment the context crosses the line, wherever that happens to be. The
 *  retained tail then starts inside a turn whose opening message the summary
 *  replaced, so the summary has to carry that turn's state or the continuation
 *  silently loses its own request.
 *
 *  omp answers this with a SECOND summarization pass over the turn prefix and
 *  merges the two under this heading. One pass is enough here: the transcript
 *  already shows which user message opened the unfinished turn, so the model can
 *  label it itself — and it does not cost a whole extra model call. */
const SPLIT_TURN_HINT =
  "If the transcript ends in the middle of a turn — its last messages belong to a user turn that has\n" +
  "not finished, typically ending on a tool result — close with a short section headed\n" +
  "`**Turn Context (split turn):**` describing that turn's state and what it still has to do.";

/** Used from the second compaction on. The previous summary is the only thing a
 *  later turn will see of the region that precedes the new interval, so the
 *  update must cover BOTH — and must not describe itself as an update, because
 *  the reader never sees the split. */
const UPDATE_TASK = [
  "The conversation inside <conversation> continues the work described by <previous-summary>.",
  "Write ONE summary covering BOTH: keep everything from the previous summary that is still",
  "true, fold in the new work, and drop whatever the new work supersedes. Write it as a single",
  "standalone summary — never mention that it updates an earlier one.",
].join("\n");

/** Render the transcript the summarizer reads. Role-tagged and line-oriented:
 *  the summarizer needs to see WHO said what and which tool produced which
 *  result, but nothing here is replayed to a provider, so it does not have to
 *  be the wire shape. */
export function serializeConversation(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    lines.push(`[${message.role}]`);
    const text = message.text?.trim();
    if (text) lines.push(text);
    for (const block of message.blocks ?? []) {
      if (block.type === "text") {
        const blockText = block.text.trim();
        if (blockText) lines.push(blockText);
      } else if (block.type === "tool_use") {
        lines.push(`  [tool_use ${block.name}] ${safeJson(block.input)}`);
      } else if (block.type === "tool_result") {
        const error = block.is_error ? " (error)" : "";
        const images = block.images?.length ? ` (+${block.images.length} image)` : "";
        lines.push(`  [tool_result${error}]${images} ${block.content.trim()}`);
      } else if (block.type === "image") {
        lines.push(`  [image ${block.mediaType}]`);
      }
      // thinking blocks reach no branch: ThinkingBlock's own contract says the
      // reasoning trace is "never rendered as conversation text", and replayed
      // thinking is only meaningful to the provider that produced it.
    }
  }
  return lines.join("\n");
}

/** The messages handed to the summarizer model. */
export function buildSummarizationRequest(
  messages: readonly Message[],
  opts?: { previousSummary?: string },
): Message[] {
  const previous = opts?.previousSummary?.trim();
  const transcript = `<conversation>\n${serializeConversation(messages)}\n</conversation>`;
  const task = `${previous ? UPDATE_TASK : FIRST_TASK}\n${SPLIT_TURN_HINT}`;
  const body = previous
    ? `${task}\n\n<previous-summary>\n${previous}\n</previous-summary>\n\n${transcript}`
    : `${task}\n\n${transcript}`;
  return [
    { role: "system", text: SUMMARIZATION_SYSTEM_PROMPT },
    { role: "user", text: body },
  ];
}

function safeJson(input: unknown): string {
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return "[unserializable input]";
  }
}

/** Which file tool touched what, as the summary reports it: a path written but
 *  never read is `(Write)`, read and written is `(RW)`, read only is `(Read)`. */
export type FileMarker = "read" | "write" | "rw";

const FILE_TOOLS: Record<string, "read" | "write"> = {
  read: "read",
  write: "write",
  edit: "write",
};

/** Files the messages touched, keyed by path. Mirrors omp's file-operation
 *  tracking, but derived from the covered entries themselves instead of being
 *  carried in entry details: compaction already holds the whole covered prefix,
 *  so a scan costs nothing and needs no new field on CompactionEntry. */
export function collectFileOperations(messages: readonly Message[]): Map<string, FileMarker> {
  const files = new Map<string, FileMarker>();
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type !== "tool_use") continue;
      const touched = FILE_TOOLS[block.name];
      if (!touched) continue;
      const path = pathOf(block.input);
      if (!path) continue;
      const seen = files.get(path);
      files.set(path, seen && seen !== touched ? "rw" : (seen ?? touched));
    }
  }
  return files;
}

export const MAX_SUMMARY_FILES = 20;

const MARKER_TEXT: Record<FileMarker, string> = {
  read: "(Read)",
  write: "(Write)",
  rw: "(RW)",
};

/** The `<files>` block, or "" when the covered region touched no files. Flat and
 *  sorted rather than omp's folded tree: at 20 entries the tree only saves
 *  width, and the paths are what the next turn needs. */
export function renderFileOperations(files: ReadonlyMap<string, FileMarker>): string {
  if (files.size === 0) return "";
  const paths = [...files.keys()].sort();
  const shown = paths.slice(0, MAX_SUMMARY_FILES);
  const lines = shown.map((path) => `${path} ${MARKER_TEXT[files.get(path) ?? "read"]}`);
  const elided = paths.length - shown.length;
  if (elided > 0) lines.push(`[…${elided} files elided…]`);
  return `<files>\n${lines.join("\n")}\n</files>`;
}

/** Attach the block to a summary, dropping any `<files>` the model wrote
 *  itself: the appended list is derived from real tool calls, so a model-made
 *  one can only be stale (omp's upsertFileOperations behaviour). */
export function upsertFileOperations(summary: string, block: string): string {
  const stripped = summary.replace(/<files>[\s\S]*?<\/files>\s*/g, "").trimEnd();
  if (!block) return stripped;
  return stripped ? `${stripped}\n\n${block}` : block;
}

function pathOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" && path.trim().length > 0 ? path : null;
}
