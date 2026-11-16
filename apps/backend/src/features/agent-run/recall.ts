/** ADR 0055: recall is an INPUT to intent recognition, not a follow-up.
 *
 *  "那个还没修好吗" cannot be classified from the sentence alone — the
 *  referent is missing. So the pipeline is:
 *
 *    cues (deterministic) → recall (bounded, with provenance) → facets → slots
 *
 *  The cue step is deliberately not a model decision. Asking a model "do you
 *  need to recall?" reproduces the failure it is meant to prevent: the model
 *  does not know something is missing. A pronoun is knowable in code.
 *
 *  Everything here degrades to "nothing found" and says so, because an
 *  assistant that claims "I don't know" without having looked is
 *  indistinguishable from one that never searches. */

export interface RecallHit {
  /** Which store answered. New stores add a value; the renderer never assumes one. */
  readonly source: "qa" | "history";
  /** Stable pointer a human or the model can cite back: `seq:412`, `action:01J…`. */
  readonly ref: string;
  readonly at: number;
  readonly text: string;
  /** Why it surfaced: the cue that matched, or "pinned" for always-on state. */
  readonly why: string;
}

export interface RecallResult {
  readonly hits: readonly RecallHit[];
  /** What was actually looked at. Printed even when empty — that is the
   *  difference between "there is nothing" and "nobody looked". */
  readonly searched: ReadonlyArray<{ source: string; hits: number }>;
}

const PRONOUN_CUES: readonly string[] = [
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
  "this",
  "that",
  "those",
  "it",
  "earlier",
  "previously",
  "last time",
  "the same",
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

export interface Cues {
  /** Human-readable reasons the recall was triggered. */
  readonly cues: readonly string[];
  /** Verbatim pointers worth searching as-is. */
  readonly identifiers: readonly string[];
  /** The query handed to keyword search (identifiers, else the text itself). */
  readonly query: string;
}

const MAX_QUERY_CHARS = 200;

export function extractCues(text: string): Cues {
  const lower = text.toLowerCase();
  const cues = PRONOUN_CUES.filter((cue) => lower.includes(cue));
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
    cues: cues.length > 0 ? cues : ids.length > 0 ? ["标识符"] : [],
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

const MAX_HITS = 6;
const HIT_CHARS = 300;

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function stamp(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The block appended to the run's product context. Fixed shape, provenance
 *  on every line: a memory without a date is how a three-month-old
 *  preference becomes today's instruction. */
export function renderRecallBlock(result: RecallResult): string {
  const lines = ["## Recall (this turn)"];
  if (result.hits.length === 0) {
    const looked = result.searched.map((s) => `${s.source}=${s.hits}`).join(", ");
    lines.push(
      `Nothing matched (searched: ${looked}). Say you looked and found nothing — do not invent, ask the human.`,
    );
    return lines.join("\n");
  }
  result.hits.forEach((hit, i) => {
    lines.push(
      `${i + 1}. [${hit.source} ${hit.ref}, ${stamp(hit.at)}] ${clip(hit.text, HIT_CHARS)}`,
      `   matched: ${hit.why}`,
    );
  });
  lines.push(
    "",
    "A recalled item may be stale. Current context and the human's latest words win;",
    "say so when they conflict instead of following the old one silently.",
  );
  return lines.join("\n");
}

/** Ports this module needs, kept structural so tests can fake them without the
 *  whole run port. */
export interface RecallPorts {
  /** Actions parked by this conversation's runs (asks + approvals). */
  listActions(conversationId: string): Promise<
    ReadonlyArray<{
      actionId: string;
      kind: string;
      status: string;
      payload: unknown;
      response: unknown;
      createdAt: number;
    }>
  >;
  searchLedger(
    keyword: string,
    limit?: number,
    scope?: { conversationId?: string },
  ): ReadonlyArray<{ seq: number; ts: number; snippet: string }>;
}

function questionsOf(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const raw = (payload as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const q of raw) {
    const text = (q as { question?: unknown })?.question;
    if (typeof text === "string" && text.trim() !== "") out.push(text.trim());
  }
  return out;
}

function answersOf(response: unknown): string {
  if (typeof response !== "object" || response === null) return "";
  const answers = (response as { answers?: unknown }).answers;
  if (!Array.isArray(answers)) return "";
  const parts: string[] = [];
  for (const a of answers) {
    const picked = (a as { selectedValues?: unknown }).selectedValues;
    const free = (a as { freeText?: unknown }).freeText;
    const value =
      Array.isArray(picked) && picked.length > 0
        ? picked.map((v) => String(v)).join(", ")
        : typeof free === "string"
          ? free
          : "";
    if (value.trim() !== "") parts.push(value.trim());
  }
  return parts.join("; ");
}

/** Fan out over what the backend owns. Long-term vector memory lives inside
 *  the run's own process, not here — it stays a run-side tool; this covers the
 *  two sources the backend is the authority on. */
export async function collectRecall(
  ports: RecallPorts,
  input: { conversationId: string; text: string },
): Promise<RecallResult> {
  const cues = extractCues(input.text);
  if (!needsRecall(cues)) {
    return { hits: [], searched: [{ source: "cues", hits: 0 }] };
  }

  // Pinned first: an open question and the answer to a closed one are the two
  // things that must never be re-asked.
  const actions = await ports.listActions(input.conversationId).catch(() => []);
  const qaHits: RecallHit[] = [];
  for (const action of actions) {
    if (action.kind !== "ask") continue;
    const questions = questionsOf(action.payload);
    if (questions.length === 0) continue;
    const answer = answersOf(action.response);
    qaHits.push({
      source: "qa",
      ref: `action:${action.actionId}`,
      at: action.createdAt,
      text:
        answer === ""
          ? `Q: ${questions.join("; ")} (still unanswered)`
          : `Q: ${questions.join("; ")} A: ${answer}`,
      why: action.status === "pending" ? "pinned: waiting on the human" : "pinned: answered",
    });
    if (qaHits.length >= 3) break;
  }

  const history = ports.searchLedger(cues.query, MAX_HITS, {
    conversationId: input.conversationId,
  });
  const historyHits: RecallHit[] = history.slice(0, MAX_HITS).map((row) => ({
    source: "history" as const,
    ref: `seq:${row.seq}`,
    at: row.ts,
    text: row.snippet,
    why: cues.cues.join(", "),
  }));

  return {
    hits: [...qaHits, ...historyHits].slice(0, MAX_HITS),
    searched: [
      { source: "qa", hits: qaHits.length },
      { source: "history", hits: historyHits.length },
    ],
  };
}

/** What a recalled line must mention for us to call it evidence for a slot.
 *  Crude on purpose: this is a hint for the MODEL to re-dispatch without
 *  re-asking, not an automatic fill (interpreting a memory snippet into a
 *  slot value is exactly the guess we refuse to make). */
const SLOT_HINTS: Record<string, readonly string[]> = {
  repro: ["复现", "重现", "步骤", "repro", "steps to reproduce"],
  expected: ["期望", "应该", "预期", "expected", "should"],
  scope: ["范围", "目录", "文件", "模块", "scope", "path", "file"],
  acceptance: ["验收", "测试", "通过", "acceptance", "test", "criteria"],
  constraints: ["约束", "不要", "禁止", "必须", "constraint", "must not", "never"],
  target: ["评", "diff", "pr", "#", "target", "review"],
  criteria: ["标准", "准则", "criteria", "standard"],
  question: ["为什么", "原因", "why", "cause", "question"],
  sources: ["日志", "监控", "证据", "log", "metric", "evidence"],
  stop: ["停止", "够", "边界", "stop", "enough"],
  audience: ["读者", "给谁", "audience", "reader"],
  form: ["格式", "长度", "篇幅", "format", "length"],
  source: ["素材", "来源", "source", "material"],
  environment: ["环境", "env", "staging", "prod"],
  action: ["执行", "动作", "重启", "部署", "action", "restart", "deploy"],
  rollback: ["回滚", "恢复", "rollback", "revert"],
};

/** Which recalled lines might answer each still-missing slot. */
export function slotEvidence(
  missing: readonly string[],
  hits: readonly RecallHit[],
): Array<{ slot: string; hits: RecallHit[] }> {
  const out: Array<{ slot: string; hits: RecallHit[] }> = [];
  for (const slot of missing) {
    const hints = SLOT_HINTS[slot] ?? [slot];
    const matching = hits.filter((hit) => {
      const haystack = hit.text.toLowerCase();
      return hints.some((hint) => haystack.includes(hint.toLowerCase()));
    });
    if (matching.length > 0) out.push({ slot, hits: matching.slice(0, 2) });
  }
  return out;
}

/** References the brief should carry whatever the model wrote: the recall it
 *  was actually given is the provenance of this dispatch. */
export function recallRefs(hits: readonly RecallHit[], existing: readonly string[]): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const hit of hits) {
    if (seen.has(hit.ref)) continue;
    seen.add(hit.ref);
    out.push(hit.ref);
    if (out.length >= 8) break;
  }
  return out;
}
