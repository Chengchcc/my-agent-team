/** Per-conversation read position (unread anchor), client-only.
 *  Single-user product (ADR 0026) and Lark owns its own unread state, so the
 *  web keeps this in localStorage instead of a server table. Values are
 *  ledger seq numbers; a conversation is unread when its `lastSeq` (from the
 *  list projection) is greater than the stored read seq. */

const KEY = "maw_read_seq";
type ReadMap = Record<string, number>;

let cache: ReadMap | null = null;
let version = 0;
const listeners = new Set<() => void>();

function load(): ReadMap {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? "{}") as ReadMap;
  } catch {
    cache = {};
  }
  return cache;
}

/** React external-store source: bump on every write so consumers re-render. */
export function subscribeReadSeq(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getReadSeqVersion(): number {
  return version;
}

export function getReadSeq(conversationId: string): number {
  return load()[conversationId] ?? 0;
}

/** Advance the read position; no-op when seq is not newer than stored. */
export function markRead(conversationId: string, seq: number): void {
  if (!seq || seq <= 0) return;
  const map = load();
  if ((map[conversationId] ?? 0) >= seq) return;
  map[conversationId] = seq;
  version += 1;
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // quota/private mode: in-memory only, unread resets next load — fine.
  }
  listeners.forEach((l) => {
    l();
  });
}

/** True when the conversation has ledger entries past the stored position. */
export function isUnread(conversationId: string, lastSeq: number | null): boolean {
  return lastSeq != null && lastSeq > getReadSeq(conversationId);
}
