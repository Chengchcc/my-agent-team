import { recallWorkers, type WorkerCard } from "../product-tools/pool.js";
import { extractCues, needsRecall } from "./cues.js";
import type { RecallHit, RecallRequest, RecallResult, RecallSource } from "./domain.js";

/** The sources this process can answer. The other two (memory, skill) live in
 *  the run's child; asking for them here reports them as skipped instead of
 *  pretending they were empty. */
const LOCAL_SOURCES: readonly RecallSource[] = ["history", "qa", "capability"];

const MAX_HITS = 6;
const MAX_PINNED_QA = 3;
const MAX_HISTORY = 6;
const HIT_CHARS = 300;

export interface RecallPorts {
  /** Ledger search, scoped to one conversation. */
  searchLedger?(
    keyword: string,
    limit?: number,
    scope?: { conversationId?: string },
  ): ReadonlyArray<{ seq: number; ts: number; snippet: string }>;
  /** Actions parked by this conversation's runs (asks + approvals). */
  listActions?(conversationId: string): Promise<
    ReadonlyArray<{
      actionId: string;
      kind: string;
      status: string;
      payload: unknown;
      response: unknown;
      createdAt: number;
    }>
  >;
  /** Capability cards, when the caller wants a worker. */
  workers?(): Promise<readonly WorkerCard[]>;
  /** The front desk's long-term memory (ADR 0064). Absent = the deployment
   *  cannot reach it, and the source reports skipped with the reason. */
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

function clip(value: string, max: number = HIT_CHARS): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
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

/** One entry point for "what do we already know about this?".
 *
 *  Same shape for every source: hits carry provenance (`ref`), time (`at`) and
 *  a reason (`why`); the result always carries what was searched, so an empty
 *  answer can be read as "looked and found nothing" rather than "did not look".
 *
 *  A source that this process cannot answer is reported in `skipped` with the
 *  reason, never silently dropped. */
export async function recall(ports: RecallPorts, request: RecallRequest): Promise<RecallResult> {
  const searched: Array<{ source: RecallSource; hits: number; detail?: string }> = [];
  const skipped: Array<{ source: RecallSource; reason: string }> = [];
  const hits: RecallHit[] = [];

  const wanted = new Set(request.sources);
  const cues = request.text === undefined ? null : extractCues(request.text);
  const query = cues?.query ?? "";

  for (const source of request.sources) {
    if (LOCAL_SOURCES.includes(source)) continue;
    // ADR 0064: memory is readable from here now (a SQLite file in the
    // agent's workspace). Skills still live in the child.
    if (source === "memory" && ports.searchMemory !== undefined) continue;
    skipped.push({
      source,
      reason:
        source === "memory"
          ? "no memory port wired (the agent's .oma/memory is unreachable here)"
          : "lives in the run's process (skill packs)",
    });
  }

  if (wanted.has("memory") && ports.searchMemory !== undefined) {
    if (request.conversationId === undefined) {
      skipped.push({ source: "memory", reason: "no conversation scope" });
    } else if (query === "") {
      skipped.push({ source: "memory", reason: "no cues in the request to search with" });
    } else {
      const found = await ports
        .searchMemory({
          conversationId: request.conversationId,
          query,
          limit: request.limit ?? 5,
        })
        .catch(() => []);
      for (const hit of found) {
        hits.push({
          source: "memory",
          ref: `mem:${hit.id}`,
          at: hit.at,
          text: hit.content,
          why: hit.why,
          ...(hit.score === undefined ? {} : { score: hit.score }),
        });
      }
      searched.push({ source: "memory", hits: found.length });
    }
  }

  if (wanted.has("qa")) {
    if (request.conversationId === undefined || ports.listActions === undefined) {
      skipped.push({ source: "qa", reason: "no conversation scope or port" });
    } else {
      const actions = await ports.listActions(request.conversationId).catch(() => []);
      let added = 0;
      for (const action of actions) {
        if (action.kind !== "ask") continue;
        const questions = questionsOf(action.payload);
        if (questions.length === 0) continue;
        const answer = answersOf(action.response);
        hits.push({
          source: "qa",
          ref: `action:${action.actionId}`,
          at: action.createdAt,
          text:
            answer === ""
              ? `Q: ${questions.join("; ")} (still unanswered)`
              : `Q: ${questions.join("; ")} A: ${answer}`,
          why: action.status === "pending" ? "pinned: waiting on the human" : "pinned: answered",
        });
        added += 1;
        if (added >= MAX_PINNED_QA) break;
      }
      searched.push({ source: "qa", hits: added, detail: "this conversation's asks, pinned" });
    }
  }

  if (wanted.has("history")) {
    if (request.conversationId === undefined || ports.searchLedger === undefined) {
      skipped.push({ source: "history", reason: "no conversation scope or ledger port" });
    } else if (cues === null || !needsRecall(cues)) {
      // Not a failure: the message stands on its own. Saying so is what keeps
      // "found nothing" and "did not look" apart.
      searched.push({ source: "history", hits: 0, detail: "no reference cues — not searched" });
    } else {
      const rows = ports.searchLedger(query, MAX_HISTORY, {
        conversationId: request.conversationId,
      });
      for (const row of rows.slice(0, MAX_HISTORY)) {
        hits.push({
          source: "history",
          ref: `seq:${row.seq}`,
          at: row.ts,
          text: clip(row.snippet),
          why: cues?.cues.join(", ") ?? "query",
        });
      }
      searched.push({ source: "history", hits: rows.length, detail: "this conversation's ledger" });
    }
  }

  if (wanted.has("capability")) {
    if (ports.workers === undefined) {
      skipped.push({ source: "capability", reason: "no worker registry wired" });
    } else {
      const cards = await ports.workers().catch(() => []);
      const result = recallWorkers(cards, request.brief ?? {});
      for (const hit of result.hits) {
        hits.push({
          source: "capability",
          ref: `agent:${hit.agentId}`,
          at: 0,
          text: hit.name,
          why: hit.why.join(", ") || "no signal matched",
          score: hit.score,
          meta: { agentId: hit.agentId },
        });
      }
      searched.push({
        source: "capability",
        hits: result.hits.length,
        detail: `${result.considered} eligible worker(s)`,
      });
    }
  }

  return { hits: hits.slice(0, request.limit ?? MAX_HITS), searched, skipped };
}

/** Render a recall result for a prompt. */
export { HIT_CHARS };
