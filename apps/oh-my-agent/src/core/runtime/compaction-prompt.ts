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
  "messages are dropped from context. The summary is the ONLY thing a later turn sees of",
  "that region, so state it can act on matters more than narrative flow.",
  "",
  "Use these sections in this order (omit any section with no content; never rename one;",
  "only add `## Turn Context (split turn)` at the end when the last user turn is unfinished):",
  "",
  "## Goal",
  "## Constraints & Preferences",
  "## Progress",
  "### Done",
  "### In Progress",
  "### Blocked",
  "## Key Decisions",
  "## Next Steps",
  "## Critical Context",
  "",
  "Rules that always apply:",
  "- If the transcript ends with an unanswered question or a request waiting on the user,",
  "  keep that request VERBATIM at the end of ## Critical Context. A pending question the",
  "  next turn forgets is a user who has to answer twice.",
  "- Keep exact identifiers: file paths, commands, error strings, branch or commit ids.",
  "- A decision carries its reason; outright rejected options are kept, not deleted.",
  "- Drop greetings, tool chatter, restatements, and anything later work supersedes.",
  "- Write in the conversation's own language. No preamble, no code fences.",
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
  "not finished, typically ending on a tool result — add a final section headed exactly\n" +
  "`## Turn Context (split turn)` describing that turn's state and what it still has to do.";

/** Used from the second compaction on. The previous summary is the only thing a
 *  later turn will see of the region that precedes the new interval, so the
 *  update must cover BOTH — and must not describe itself as an update, because
 *  the reader never sees the split. */
const UPDATE_TASK = [
  "The conversation inside <conversation> continues the work described by <previous-summary>.",
  "Write ONE summary covering BOTH, using the same sections:",
  "- keep every section from the previous summary that is still true, and add what the new",
  "  messages established;",
  "- move finished items out of ### In Progress into ### Done;",
  "- a pending question that is STILL unanswered stays verbatim in ## Critical Context;",
  "  once it has an answer, drop it and keep only the resulting decision;",
  "- drop whatever the new work supersedes.",
  "Write it as a single standalone summary — never mention that it updates an earlier one.",
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

/** Every machine-maintained block. The model must not write these: each is
 *  derived from the real tool calls in the covered region, so a model-made one
 *  can only be stale — and two copies drift apart. */
const STATE_BLOCK_RE = /<(files|commands|qa)>[\s\S]*?<\/\1>\s*/g;

/** Attach the machine-maintained blocks to a summary, dropping whatever the
 *  model wrote for them. Rebuilding from the whole covered prefix (below) is
 *  what makes them survive repeated compaction — no field has to be carried
 *  between entries. */
export function upsertStateBlocks(summary: string, blocks: string): string {
  const stripped = summary.replace(STATE_BLOCK_RE, "").trimEnd();
  if (blocks === "") return stripped;
  return stripped ? `${stripped}\n\n${blocks}` : blocks;
}

/** Commands the covered region ran. Most recent last, deduped, each capped:
 *  a 400-line heredoc is not something the next turn can act on. */
export const MAX_SUMMARY_COMMANDS = 15;
const COMMAND_CHARS = 200;

const SHELL_TOOLS: Record<string, true> = { bash: true };

export function collectCommands(messages: readonly Message[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type !== "tool_use" || !SHELL_TOOLS[block.name]) continue;
      const input = block.input as { command?: unknown } | null;
      const raw = typeof input?.command === "string" ? input.command.trim() : "";
      if (raw === "") continue;
      const cmd = raw.length > COMMAND_CHARS ? `${raw.slice(0, COMMAND_CHARS)}…` : raw;
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      out.push(cmd);
    }
  }
  return out;
}

export function renderCommands(commands: readonly string[]): string {
  if (commands.length === 0) return "";
  const shown = commands.slice(-MAX_SUMMARY_COMMANDS);
  const elided = commands.length - shown.length;
  const head = elided > 0 ? `[…${elided} earlier…]` : null;
  const lines = [...(head ? [head] : []), ...shown.map((c) => `$ ${c}`)];
  return `<commands>\n${lines.join("\n")}\n</commands>`;
}

/** One question the run put to a human, with the answer it got. */
export interface QaPair {
  readonly question: string;
  readonly answer: string;
}

export const MAX_SUMMARY_QA = 10;
const QA_CHARS = 200;

/** ask_question calls paired with their results. These are the single most
 *  expensive thing to lose: the human already answered, and asking again is
 *  what makes an assistant feel like it is not listening. */
export function collectQa(messages: readonly Message[]): QaPair[] {
  const results = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type === "tool_result") results.set(block.tool_use_id, block.content);
    }
  }
  const out: QaPair[] = [];
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type !== "tool_use" || !block.name.endsWith("ask_question")) continue;
      const question = askQuestions(block.input);
      if (question === "") continue;
      out.push({ question, answer: askAnswer(results.get(block.id)) });
    }
  }
  return out;
}

export function renderQa(pairs: readonly QaPair[]): string {
  if (pairs.length === 0) return "";
  const shown = pairs.slice(-MAX_SUMMARY_QA);
  return `<qa>\n${shown.map((p) => `Q: ${p.question}\nA: ${p.answer}`).join("\n")}\n</qa>`;
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function askQuestions(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return "";
  const texts: string[] = [];
  for (const q of questions) {
    const text =
      typeof (q as { question?: unknown })?.question === "string"
        ? (q as { question: string }).question
        : "";
    if (text.trim() !== "") texts.push(clip(text, QA_CHARS));
  }
  return texts.join("; ");
}

function askAnswer(content: string | undefined): string {
  if (content === undefined || content.trim() === "") return "(no answer)";
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return clip(content, QA_CHARS);
  }
  if (typeof parsed !== "object" || parsed === null) return clip(content, QA_CHARS);
  const obj = parsed as { answers?: unknown; error?: unknown };
  if (typeof obj.error === "string") return `(no answer: ${clip(obj.error, 80)})`;
  if (!Array.isArray(obj.answers)) return clip(content, QA_CHARS);
  const parts: string[] = [];
  for (const a of obj.answers) {
    const picked = (a as { selectedValues?: unknown }).selectedValues;
    const free = (a as { freeText?: unknown }).freeText;
    const value =
      Array.isArray(picked) && picked.length > 0
        ? picked.map((v) => String(v)).join(", ")
        : typeof free === "string"
          ? free
          : "";
    if (value.trim() !== "") parts.push(clip(value, QA_CHARS));
  }
  return parts.length > 0 ? parts.join("; ") : "(no answer)";
}

function pathOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" && path.trim().length > 0 ? path : null;
}
