import { z } from "zod";

// ─── LedgerKind — single source of truth for entry kind ──

export const LedgerKind = z.enum([
  "message",
  "member.joined",
  "member.left",
  "todo",
  "surface.control",
]);

/** Type-level LedgerKind — use this for type annotations.
 *  The zod const is the runtime validator; this is the type alias. */
export type LedgerKind = z.infer<typeof LedgerKind>;

// ─── LedgerEntry ────────────────────────────────────────────

export const LedgerEntry = z.object({
  seq: z.number(),
  conversationId: z.string(),
  senderMemberId: z.string(),
  addressedTo: z.array(z.string()).default([]),
  kind: LedgerKind,
  // content is always a serialized string (JSON.stringify for structured payloads).
  // Message entries use serializeMessageRevision; other kinds use JSON.stringify.
  content: z.string(),
  ts: z.number(),
  /** Run that produced this entry. Present for assistant messages (run traceability),
   *  absent for human/system messages. */
  runId: z.string().optional(),
});

export type LedgerEntry = z.infer<typeof LedgerEntry>;

/** Parse a ledger entry from wire/SSE, throwing on invalid shape. */
export function parseLedgerEntry(raw: unknown): LedgerEntry {
  return LedgerEntry.parse(raw);
}

/** Safe-parse a ledger entry (returns success/error instead of throwing). */
export function safeParseLedgerEntry(raw: unknown): z.SafeParseReturnType<unknown, LedgerEntry> {
  return LedgerEntry.safeParse(raw);
}

/** Serialize a ledger entry to JSON. */
export function serializeLedgerEntry(e: LedgerEntry): string {
  return JSON.stringify(LedgerEntry.parse(e));
}
