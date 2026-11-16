/** ADR 0052: pooled dispatch — the front names WHAT it needs, not WHO.
 *
 *  Deterministic on purpose: a model-based router on the dispatch path would
 *  be a second thing that can be down (the same reason ADR 0048's assessment
 *  only runs off the hot path). Ranking is explainable and cheap:
 *
 *    1. idle before busy          (active runs across every conversation)
 *    2. least recently started    (spreads work instead of always picking A)
 *    3. stable id order           (ties never flap between two picks)
 *
 *  Capability narrowing is a case-insensitive substring over the card's
 *  skills and description — the same crude matching the ambient rules use,
 *  for the same reason: a mistyped regex fails silently, a missing substring
 *  just widens the pool. */

export interface PoolCandidate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly skills: readonly string[];
  readonly role: "front" | "worker" | null;
  readonly activeRuns: number;
  /** Newest run start; 0 when the agent never ran. */
  readonly lastRunAt: number;
}

export interface PoolPick {
  readonly agentId: string;
  /** Why this one — returned to the model so it can see the choice. */
  readonly reason: string;
  /** How many candidates the pool considered (after capability narrowing). */
  readonly considered: number;
}

function matches(agent: PoolCandidate, capability: string): boolean {
  const needle = capability.toLowerCase();
  if (agent.description.toLowerCase().includes(needle)) return true;
  return agent.skills.some((s) => s.toLowerCase().includes(needle));
}

/** Workers only: a front is where humans talk, never a dispatch target of
 *  its own pool (named dispatch can still reach one explicitly). */
export function pickFromPool(
  candidates: readonly PoolCandidate[],
  capability?: string,
): PoolPick | null {
  const workers = candidates.filter((c) => c.role === "worker");
  if (workers.length === 0) return null;
  const narrowed =
    capability !== undefined && capability.trim() !== ""
      ? workers.filter((c) => matches(c, capability.trim()))
      : workers;
  if (narrowed.length === 0) return null;
  const ranked = [...narrowed].sort(
    (a, b) => a.activeRuns - b.activeRuns || a.lastRunAt - b.lastRunAt || a.id.localeCompare(b.id),
  );
  const chosen = ranked[0]!;
  const why: string[] = [];
  why.push(chosen.activeRuns === 0 ? "idle" : `${chosen.activeRuns} active run(s)`);
  if (capability !== undefined && capability.trim() !== "") why.push(`matched “${capability}”`);
  if (narrowed.length > 1) why.push(`picked from ${narrowed.length}`);
  return { agentId: chosen.id, reason: why.join(", "), considered: narrowed.length };
}
