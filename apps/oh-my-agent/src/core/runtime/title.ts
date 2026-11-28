import { extractText, type Message } from "@chengchenccc/message";
import type { PluginRuntime } from "./plugin-runtime.js";

// ── Low-signal pre-filter (deterministic, no model call) ──────────────────
// Absorbed: greetings, single words, and
// pure filler are skipped without wasting a model call.

const TITLE_WORD = /\p{L}[\p{L}\p{N}_'-]*/gu;
const FILLER_TOKENS = new Set([
  "hi",
  "hey",
  "hello",
  "yo",
  "sup",
  "ok",
  "okay",
  "yes",
  "no",
  "yeah",
  "thanks",
  "thank",
  "thx",
  "bye",
  "lol",
  "haha",
  "wow",
  "cool",
  "nice",
  "great",
  "sure",
  "right",
  "please",
  "test",
  "ping",
  "你好",
  "在吗",
  "测试",
  "好的",
  "谢谢",
  "哈喽",
  "嗨",
]);

export function isLowSignalTitleInput(message: string): boolean {
  const tokens = message.toLowerCase().match(TITLE_WORD);
  if (!tokens) return true;
  return tokens.every((t) => FILLER_TOKENS.has(t) || /^\d+$/.test(t));
}

// ── Prompt (XML tag format + few-shot) ───────────────────────

const TITLE_SYSTEM_PROMPT = `Write a 3-7 word title and a one-sentence summary for the task.

Answer with only these two tags, nothing before or after:
<title>the title</title>
<summary>one sentence on what the user wants and where it stands</summary>
If there is no concrete task (greeting, small talk, acknowledgment), output exactly:
<title>none</title>
<summary>none</summary>
Match the user's language (Chinese for Chinese requests, English for English requests).
Capitalize only the first word and proper names in English.

Examples:
User: the login button is broken on mobile, can you fix?
<title>Fix login button on mobile</title>
<summary>The mobile login button is unresponsive; the fix has not started yet.</summary>

User: refactor error handling in the API client
<title>Refactor API error handling</title>
<summary>Reworking the API client's error handling onto typed errors.</summary>

User: hey
<title>none</title>
<summary>none</summary>`;

// ── Normalization (robust extraction) ────────────────────────

const MAX_TITLE_CHARS = 80;
const MAX_TITLE_WORDS = 12;
const MAX_SUMMARY_CHARS = 240;
const MAX_MESSAGE_EXCERPT_CHARS = 500;
const MAX_TITLE_CONTEXT_CHARS = 2_400;
const NO_TITLE_SENTINELS = new Set(["none", "（无）", "无"]);
const TITLE_TAG = /<title>([\s\S]*?)<\/title>/i;
const SUMMARY_TAG = /<summary>([\s\S]*?)<\/summary>/i;

function stripTitleDecoration(raw: string): string {
  return raw
    .replace(/^<title>/i, "")
    .replace(/<\/title>$/i, "")
    .replace(/^#+\s*/, "")
    .replace(/^\*{1,2}(.+?)\*{1,2}$/, "$1")
    .replace(/^`(.+?)`$/, "$1")
    .replace(/^["'「『]|["'」』]$/g, "")
    .replace(/[.!?。！？]$/, "")
    .trim();
}

export function normalizeGeneratedTitle(raw: string): string | null {
  // A tagged reply is authoritative (the combined title+summary answer puts
  // the two tags on their own lines, so the old first-line-only read would
  // have swallowed the summary into the title).
  const tagged = TITLE_TAG.exec(raw)?.[1];
  const candidate = tagged ?? raw.trim().split(/\r?\n/, 1)[0] ?? "";
  const title = stripTitleDecoration(candidate.trim());
  if (!title || NO_TITLE_SENTINELS.has(title.toLowerCase())) return null;
  // Reject overlong output (model answered instead of titling)
  if (title.length > MAX_TITLE_CHARS) return null;
  if ((title.match(TITLE_WORD)?.length ?? 0) > MAX_TITLE_WORDS) return null;
  return title;
}

/** The one-sentence session summary that rides the title call. Null when the
 *  model answered with a bare title (older prompts, weak models) — the resume
 *  list then falls back to the title/preview it showed before. */
export function normalizeGeneratedSummary(raw: string): string | null {
  const tagged = SUMMARY_TAG.exec(raw)?.[1];
  if (tagged === undefined) return null;
  const summary = tagged.replace(/\s+/g, " ").trim();
  if (!summary || NO_TITLE_SENTINELS.has(summary.toLowerCase())) return null;
  if (summary.length <= MAX_SUMMARY_CHARS) return summary;
  // Long answers are model overshoot: keep the first sentence-ish slice at a
  // word boundary rather than a hard cut mid-word.
  const clipped = summary.slice(0, MAX_SUMMARY_CHARS);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > MAX_SUMMARY_CHARS / 2 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

// ── Context builder ───────────────────────────────────────────────────────

function clipExcerpt(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1).trimEnd()}…`;
}

export function buildTitleContext(msgs: Message[], maxTurns = 4): string {
  // Keep only non-empty conversational turns so 20+ empty-text tool-calling
  // assistant turns never crowd out the user's original task prompt.
  const conversational: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const m of msgs) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = clipExcerpt(extractText(m), MAX_MESSAGE_EXCERPT_CHARS);
    if (!text) continue;
    conversational.push({ role: m.role, text });
  }
  if (conversational.length === 0) return "";

  // Slice from the last `maxTurns` user turns so recent substantive prompts win
  // over earlier greetings while preserving the user prompt across tool loops.
  const userIndices: number[] = [];
  for (let i = 0; i < conversational.length; i++) {
    if (conversational[i]!.role === "user") userIndices.push(i);
  }
  const startIdx =
    userIndices.length > maxTurns
      ? userIndices[userIndices.length - maxTurns]!
      : Math.max(0, conversational.length - maxTurns * 2);

  const lines: string[] = [];
  let totalChars = 0;
  for (const item of conversational.slice(startIdx)) {
    const line = `${item.role === "user" ? "User" : "Assistant"}: ${item.text}`;
    if (totalChars + line.length > MAX_TITLE_CONTEXT_CHARS && lines.length > 0) {
      const remaining = MAX_TITLE_CONTEXT_CHARS - totalChars;
      if (remaining > 40) lines.push(clipExcerpt(line, remaining));
      break;
    }
    lines.push(line);
    totalChars += line.length + 1;
  }
  return lines.join("\n");
}

// ── Title generation (uses runEphemeralTurn) ──────────────────────────────

/** Title + summary from ONE ephemeral call. Both ride the same 3-7-word
 *  prompt because a second call would double the per-session cost for a
 *  resume-list nicety; a weak model that answers title-only still yields a
 *  usable title and a null summary. */
export interface GeneratedLabels {
  readonly title: string | null;
  readonly summary: string | null;
}

export async function generateTitleAndSummary(
  rt: PluginRuntime,
  context: string,
): Promise<GeneratedLabels> {
  if (!context || context.length < 4) return { title: null, summary: null };
  if (isLowSignalTitleInput(context)) return { title: null, summary: null };
  try {
    const ephemeral = rt.runEphemeralTurn;
    if (!ephemeral) return { title: null, summary: null };
    const raw = await ephemeral(
      `${TITLE_SYSTEM_PROMPT}\n\n<conversation>\n${context}\n</conversation>`,
      { signal: rt.signal, standalone: true },
    );
    return {
      title: normalizeGeneratedTitle(raw),
      summary: normalizeGeneratedSummary(raw),
    };
  } catch (err) {
    // Silent-null used to hide provider failures entirely — surface them so
    // "auto title stopped working" is diagnosable from the child's stderr.
    console.warn(
      `[oma] auto-title generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { title: null, summary: null };
  }
}
