/** ADR 0056 (supersedes ADR 0052's pool rule): choosing a worker IS a recall.
 *
 *  Same shape as memory recall and skill recall: an index (capability cards) is
 *  queried by a constructed query (the brief), and the answer is ranked hits
 *  with a reason each plus a manifest of what was considered. One vocabulary
 *  for "which of these do I know about" across memory, skills and agents means
 *  one place to fix when recall is wrong.
 *
 *  What changed from a plain pool: the query is the BRIEF (verb, deliverable,
 *  object, capability), not one free-text hint. Before this, a `review` could
 *  land on a worker whose card only ever mentions fixing bugs, because the
 *  verb never reached the matcher.
 *
 *  Deterministic: no model call on the dispatch path (ADR 0048's reason — a
 *  router that can be down is not a router). Every score component has a name,
 *  and the name is what the model sees back. */

export interface WorkerCard {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly skills: readonly string[];
  readonly role: "front" | "worker" | null;
  readonly activeRuns: number;
  /** Newest run start; 0 when the agent never ran. */
  readonly lastRunAt: number;
}

export interface WorkerQuery {
  /** fix | build | review | investigate | write | operate — never "answer". */
  readonly verb?: string;
  readonly deliverable?: string;
  /** What the work acts on, in the requester's words. */
  readonly object?: string;
  readonly objectKind?: string;
  /** The front's own hint ("react", "backend"). Still useful, no longer the
   *  only signal. */
  readonly capability?: string;
  /** Words lifted from the brief's slots (scope paths, target, criteria). */
  readonly terms?: readonly string[];
}

export interface WorkerHit {
  readonly agentId: string;
  readonly name: string;
  readonly score: number;
  /** One entry per scoring component that fired — human-readable, and shown to
   *  the model so it can disagree with the choice. */
  readonly why: readonly string[];
}

export interface WorkerRecall {
  readonly hits: readonly WorkerHit[];
  /** Workers that were eligible (role + enabled) before scoring. */
  readonly considered: number;
  /** Why some were dropped, kept so an empty result can explain itself. */
  readonly excluded: ReadonlyArray<{ agentId: string; reason: string }>;
}

/** How each verb is likely to be described on a capability card. Substring
 *  matching on purpose: a mistyped pattern fails silently, a missing synonym
 *  just weakens one signal. */
const VERB_WORDS: Record<string, readonly string[]> = {
  fix: ["fix", "bug", "修", "修复", "故障", "报错", "debug"],
  build: ["build", "implement", "feature", "开发", "实现", "新建", "搭建"],
  review: ["review", "评审", "审查", "code review", "检查", "评估"],
  investigate: ["investigate", "diagnose", "排查", "调查", "定位", "分析", "查"],
  write: ["write", "docs", "document", "文档", "撰写", "写作", "说明"],
  operate: ["operate", "deploy", "release", "运维", "部署", "发布", "重启", "restart"],
};

const OBJECT_WORDS: Record<string, readonly string[]> = {
  code: ["code", "代码", "react", "api", "backend", "frontend", "web"],
  doc: ["doc", "文档", "写作", "readme", "笔记"],
  service: ["service", "服务", "部署", "环境", "staging", "prod", "运维"],
  data: ["data", "数据", "etl", "报表", "指标"],
};

const WEIGHT = {
  verb: 4,
  objectKind: 2,
  capability: 3,
  term: 1,
} as const;

function cardText(card: WorkerCard): string {
  return [card.name, card.description, ...card.skills].join(" ").toLowerCase();
}

function hitWords(text: string, words: readonly string[]): string[] {
  return words.filter((w) => w !== "" && text.includes(w.toLowerCase()));
}

/** Rank workers for a brief. Ties fall back to idle → least recently started →
 *  id, so two identical calls never flap between equals. */
export function recallWorkers(cards: readonly WorkerCard[], query: WorkerQuery): WorkerRecall {
  const excluded: Array<{ agentId: string; reason: string }> = [];
  const eligible: WorkerCard[] = [];
  for (const card of cards) {
    if (card.role !== "worker") {
      excluded.push({ agentId: card.id, reason: "not a worker role" });
      continue;
    }
    eligible.push(card);
  }

  const scored = eligible.map((card) => {
    const text = cardText(card);
    const why: string[] = [];
    let score = 0;

    if (query.verb !== undefined) {
      const words = hitWords(text, VERB_WORDS[query.verb] ?? [query.verb]);
      if (words.length > 0) {
        score += WEIGHT.verb;
        why.push(`verb ${query.verb} (${words.slice(0, 2).join("/")})`);
      }
    }
    if (query.objectKind !== undefined) {
      const words = hitWords(text, OBJECT_WORDS[query.objectKind] ?? []);
      if (words.length > 0) {
        score += WEIGHT.objectKind;
        why.push(`object ${query.objectKind} (${words.slice(0, 2).join("/")})`);
      }
    }
    const capability = query.capability?.trim();
    if (capability !== undefined && capability !== "" && text.includes(capability.toLowerCase())) {
      score += WEIGHT.capability;
      why.push(`capability ${capability}`);
    }
    // Slot values arrive as phrases ("src/web/settings"), so they are split
    // into segments before matching: a path is evidence through its words, not
    // as one opaque string no card would ever contain.
    const terms = (query.terms ?? [])
      .flatMap((t) => t.split(/[\s,，;；/\\.]+/))
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    const termHits = terms.filter((t) => text.includes(t.toLowerCase()));
    if (termHits.length > 0) {
      score += WEIGHT.term * Math.min(termHits.length, 2);
      why.push(`brief mentions (${termHits.slice(0, 2).join("/")})`);
    }
    // Idleness is a TIE-BREAKER, not a score: as a bonus it would let a busy
    // worker that actually matches the verb lose to an idle one that does not.
    if (card.activeRuns === 0) why.push("idle");
    return { card, score, why };
  });

  // A verb with no card signal still has to produce an answer: the front asked
  // for work, and silence is worse than a best-effort pick it can override.
  const ranked = [...scored].sort(
    (a, b) =>
      b.score - a.score ||
      a.card.activeRuns - b.card.activeRuns ||
      a.card.lastRunAt - b.card.lastRunAt ||
      a.card.id.localeCompare(b.card.id),
  );

  return {
    hits: ranked.map((r) => ({
      agentId: r.card.id,
      name: r.card.name,
      score: r.score,
      why: r.why,
    })),
    considered: eligible.length,
    excluded,
  };
}

/** One-line reason handed back to the dispatching model: what it hit on, plus
 *  how many others were in the running. */
export function describePick(hit: WorkerHit, recall: WorkerRecall): string {
  const parts = [...hit.why];
  if (recall.considered > 1) parts.push(`chosen from ${recall.considered}`);
  return parts.join(", ");
}
