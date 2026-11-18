import { extractCues, needsRecall } from "../recall/cues.js";
import type { RecallHit, RecallResult } from "../recall/domain.js";
import { recall } from "../recall/recall.js";

export type { Cues } from "../recall/cues.js";
export type { RecallHit, RecallResult } from "../recall/domain.js";
/** ADR 0055/0058: recall as an input to intent recognition.
 *
 *  "那个还没修好吗" cannot be classified from the sentence alone — the
 *  referent is missing. Cues are extracted in code (a pronoun is knowable in
 *  a regex; "do you need to recall?" is not something a model can answer), and
 *  the collection itself now goes through the ONE recall entry shared with
 *  capability selection (ADR 0058). */
export { extractCues, needsRecall };

export interface RecallPorts {
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
  /** ADR 0064: the front desk's long-term memory (workspace SQLite). */
  searchMemory?(input: { conversationId: string; query: string; limit: number }): Promise<
    ReadonlyArray<{
      id: string;
      content: string;
      source: string;
      at: number;
      why: string;
      score?: number;
    }>
  >;
}

const HIT_CHARS = 300;

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function stamp(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The block appended to the run's product context. Fixed shape, provenance on
 *  every line: a memory without a date is how a three-month-old preference
 *  becomes today's instruction. */
export function renderRecallBlock(result: RecallResult): string {
  const lines = ["## Recall (this turn)"];
  if (result.hits.length === 0) {
    const looked = result.searched.map((s) => `${s.source}=${s.hits}`).join(", ");
    const skipped = result.skipped.map((s) => `${s.source}: ${s.reason}`).join("; ");
    lines.push(
      `Nothing matched (searched: ${looked || "nothing"}).${
        skipped === "" ? "" : ` Not searched here: ${skipped}.`
      } Say you looked and found nothing — do not invent, ask the human.`,
    );
    return lines.join("\n");
  }
  result.hits.forEach((hit, i) => {
    const when = hit.at > 0 ? `, ${stamp(hit.at)}` : "";
    lines.push(
      `${i + 1}. [${hit.source} ${hit.ref}${when}] ${clip(hit.text, HIT_CHARS)}`,
      `   matched: ${hit.why}`,
    );
  });
  if (result.skipped.length > 0) {
    lines.push(
      "",
      `Not searched here: ${result.skipped.map((s) => `${s.source} (${s.reason})`).join("; ")}.`,
    );
  }
  lines.push(
    "",
    "A recalled item may be stale. Current context and the human's latest words win;",
    "say so when they conflict instead of following the old one silently.",
  );
  return lines.join("\n");
}

/** Collect for a run's message. Thin by design: the vocabulary and the
 *  fan-out live in `features/recall`, so dispatch, chat and worker selection
 *  cannot drift into three different shapes again. */
export async function collectRecall(
  ports: RecallPorts,
  input: { conversationId: string; text: string },
): Promise<RecallResult> {
  const cues = extractCues(input.text);
  if (!needsRecall(cues)) {
    return {
      hits: [],
      searched: [{ source: "history", hits: 0, detail: "no reference cues" }],
      skipped: [],
    };
  }
  return recall(
    {
      listActions: (id) => ports.listActions(id),
      searchLedger: ports.searchLedger,
      ...(ports.searchMemory ? { searchMemory: ports.searchMemory } : {}),
    },
    {
      // ADR 0064: memory joins the same fan-out; without a port it reports
      // skipped instead of pretending it was searched.
      sources: ["qa", "history", "memory"],
      conversationId: input.conversationId,
      text: input.text,
    },
  );
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
