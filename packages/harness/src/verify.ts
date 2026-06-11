/**
 * M14.6: Cold-review verification guidance.
 *
 * Injected into a forked agent after the main task loop completes.
 * The cold reviewer re-opens artifacts and verifies each plan item
 * was actually satisfied — without the optimistic bias of the main
 * thread's reasoning context.
 *
 * Sister file to reflect.ts (reflectionGuidance).
 */
export function verificationGuidance(): string {
  return [
    "You are a cold reviewer. The conversation above is a task someone just",
    "claimed to finish, along with the plan they were given.",
    "",
    "Do NOT trust their narration. Re-open the artifacts they produced",
    "(read files, grep, re-run read-only checks) and verify each plan item",
    "is actually satisfied.",
    "",
    "Reply with a single JSON object: { \"complete\": boolean, \"missing\": string }.",
    "If complete=false, `missing` lists concretely what is still undone.",
  ].join("\n");
}
