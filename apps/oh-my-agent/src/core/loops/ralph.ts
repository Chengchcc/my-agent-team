import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoopConditionConfig } from "./condition.js";

/** The build loop ("ralph"): one work item per iteration, each iteration in a
 *  fresh session, with the queue and the repo as the only memory between them.
 *
 *  The mechanism is loop mode's (`reset` already restarts the session); what
 *  this file adds is the discipline that makes the restart survivable — a
 *  queue on disk, a per-iteration protocol, and the stop condition derived
 *  from that queue. */

/** The work queue, relative to the workspace root. Project-scoped, NOT the
 *  session-keyed plan drafts: every iteration runs in a fresh session, so a
 *  session-keyed path would hand each iteration a different (empty) file and
 *  the loop would lose its place — which is the entire point of the queue. */
export const RALPH_QUEUE = ".oma/plan.md";

/** Continue while an unchecked item remains. The condition runs with the
 *  workspace root as its cwd; a missing queue exits 2, which the evaluator
 *  reports as a broken condition rather than as "finished" — deleting the
 *  queue mid-loop must not read as success. */
export const RALPH_QUEUE_CHECK = `grep -q "^- \\[ \\]" ${RALPH_QUEUE}`;

export function ralphQueuePath(workspaceRoot: string): string {
  return join(workspaceRoot, RALPH_QUEUE);
}

/** The default stop condition: the queue decides, not the model's opinion of
 *  its own progress. Overridable — `/loop --until 'bun test'` swaps the
 *  authority to the verifier. */
export function ralphCondition(): LoopConditionConfig {
  return { command: RALPH_QUEUE_CHECK, until: false };
}

/** One iteration's instructions. The queue is the plan; the model's job is to
 *  shrink it by exactly one item and leave the repo in a state it can be
 *  resumed from, because the next iteration remembers nothing else. */
export const RALPH_PROTOCOL = `You are one iteration of an autonomous build loop. You start with a fresh
context every iteration: the repository and ${RALPH_QUEUE} are the only memory.
Another iteration follows you, and it will not see this conversation.

1. Read ${RALPH_QUEUE}. It is a work queue: \`- [ ]\` is todo, \`- [x]\` is done.
2. Pick the SINGLE most important unchecked item.
3. Do only that item. Implement it properly; do not start a second one.
4. Verify with the project's own checks (tests, typecheck, lint). Fix failures
   before you finish. Never mark an item done while its verification fails.
5. Mark it \`- [x]\` in ${RALPH_QUEUE}. If the work revealed new work, append it
   as a new \`- [ ]\` item instead of doing it now — that is how the queue stays
   honest.
6. Commit everything you changed: one commit, message says what the item was.
   The queue goes in that commit when the project tracks it; if it is ignored,
   leave it alone rather than forcing it in.
7. Stop. Do not summarise, do not ask whether to continue.

If every item is already checked, change nothing and say the queue is empty.`;

const RALPH_STUB = `# Work queue

\`- [ ]\` is todo, \`- [x]\` is done — one item per line, most important first.
An iteration does exactly one item and then stops.

- [ ] Study the repository and the request, then replace this file with a
      prioritised queue of concrete, independently verifiable work items.
`;

/** Create the queue on first use. An existing queue is never touched — it is
 *  the loop's memory, and rewriting it would discard the loop's progress.
 *  `item` seeds a single concrete item instead of the "write the queue" stub,
 *  which turns iteration one into the first build step rather than a planning
 *  step. */
export function seedRalphQueue(
  workspaceRoot: string,
  item?: string,
): { path: string; created: boolean } {
  const path = ralphQueuePath(workspaceRoot);
  if (existsSync(path)) return { path, created: false };
  const seeded = item?.trim();
  const body = seeded ? `# Work queue\n\n- [ ] ${seeded}\n` : RALPH_STUB;
  mkdirSync(join(workspaceRoot, ".oma"), { recursive: true });
  writeFileSync(path, body, "utf-8");
  return { path, created: true };
}
