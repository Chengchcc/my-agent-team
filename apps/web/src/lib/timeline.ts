export { extractText } from "@chengchenccc/message";

/** The run that produced a message, from its LEDGER id (`run:<runId>:...`).
 *
 *  Live-found bug (2026-11-18, product test): this used to read a field off
 *  the message revision, which never carries one - the AHP projection puts
 *  the ledger id on the timeline ITEM (`chat-state.ts`), and `content` is
 *  only `{role, text}`. The result was null for every message, silently
 *  disabling both the artifacts-under-a-reply mount and the dispatch tree.
 *  `msg:` ids (human messages, cross-agent notes) carry no run: null. */
export function runIdOfSource(id: string | null | undefined): string | null {
  if (typeof id !== "string") return null;
  const match = /^run:([^:]+):/.exec(id);
  return match ? match[1]! : null;
}
