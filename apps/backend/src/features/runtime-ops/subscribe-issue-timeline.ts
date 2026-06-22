import type { RuntimeOpsStore } from "./store.js";
import type { IssueEvent } from "./types.js";

/** SSE async generator: catch-up existing events + long-poll for new ones.
 *  Reuses the M18.4 subscribeIssues pattern — catch-up first, then poll loop with heartbeat. */
export async function* subscribeIssueTimeline(
  opsStore: RuntimeOpsStore,
  issueId: string,
  opts?: { signal?: AbortSignal; pollMs?: number },
): AsyncIterable<IssueEvent | { _heartbeat: true }> {
  const pollMs = opts?.pollMs ?? 500;
  let lastSeq = 0;
  let silentPolls = 0;
  const heartbeatInterval = 30; // ~15s at 500ms poll

  // Catch-up: yield all existing events, track highest seq
  const initial = opsStore.getIssueEvents(issueId, 0);
  for (const e of initial) {
    yield e;
    lastSeq = e.seq;
  }

  // Long-poll for new events
  while (!opts?.signal?.aborted) {
    const next = opsStore.getIssueEvents(issueId, lastSeq);
    if (next.length > 0) {
      for (const e of next) {
        yield e;
        lastSeq = e.seq;
      }
      silentPolls = 0;
    } else {
      if (pollMs === 0) break; // one-shot for tests
      silentPolls++;
      if (silentPolls % heartbeatInterval === 0) {
        yield { _heartbeat: true };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
