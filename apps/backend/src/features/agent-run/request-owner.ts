/** ADR 0075: who a parked request belongs to.
 *
 *  A worker's question is not automatically the human's: the agent that
 *  dispatched the work usually holds the missing context (the brief, the
 *  project, the wiki). Routing it straight to the person spends attention on
 *  something the team can settle itself — and, live, it also meant the person
 *  never saw the request at all, because worker rooms have no chat binding.
 *
 *  This module answers one question with no IO so both creation paths (an ask
 *  and an approval) agree: WHO should look at this first. */

export type RequestOwner = { owner: string; agentId: string | null };

/** Parse the dispatcher out of an authorization basis. `user`, `ambient:*`,
 *  `system` and workflow bases have no dispatcher. */
export function dispatcherOf(authorization: string | null): string | null {
  if (authorization === null) return null;
  const match = /^(?:dispatch|handback):(.+)$/.exec(authorization);
  return match === null ? null : match[1]!;
}

/** The owner for a request raised by `run`.
 *
 *  - dispatched work → the dispatcher, but ONLY when it is a front desk: a
 *    worker that dispatched another worker has no more context than the asker,
 *    and chaining the question upward through workers is how it never reaches
 *    anyone. A worker dispatcher escalates straight to the human.
 *  - everything else → the human.
 */
export function requestOwnerOf(input: {
  authorization: string | null;
  /** Role lookup for the dispatcher id; absent = treat it as a front. */
  roleOf?: (agentId: string) => "worker" | "front" | null;
}): RequestOwner {
  const dispatcher = dispatcherOf(input.authorization);
  if (dispatcher === null) return { owner: "user", agentId: null };
  const role = input.roleOf?.(dispatcher) ?? "front";
  if (role === "worker") return { owner: "user", agentId: null };
  return { owner: `agent:${dispatcher}`, agentId: dispatcher };
}
