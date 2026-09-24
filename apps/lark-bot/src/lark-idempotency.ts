import { createHash } from "node:crypto";

/**
 * Lark's idempotency-key field rejects values longer than 50 characters
 * (99992402 "field validation failed" — measured 2026-09-23) and our
 * natural keys are longer: a conversationId is 25 chars and a canonical
 * assistant messageId (`run:<runId>:assistant:<n>`) is ~41. Hash the tuple
 * into a fixed-length key instead — deterministic across replays, which is
 * what makes the at-least-once redelivery a Lark-side no-op.
 */
export function larkIdempotencyKey(...parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 40);
}
