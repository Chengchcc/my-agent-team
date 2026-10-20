/** Chat display names, resolved from the OpenAPI and cached in memory.
 *
 *  The heartbeat otherwise carries bare ids, and nobody administers a channel
 *  by `oc_...` strings. Resolution happens in the background so the 30s beat
 *  stays synchronous and never blocks on the network; a failed lookup is
 *  cached as "no name" and retried after the TTL instead of once per beat.
 *  (Reference: OpenClaw's Feishu access-control docs tell operators to copy
 *  the id out of the group's settings page - the name is what makes that list
 *  readable, and Feishu hands both from the same chat-info call.) */
const TTL_MS = 60 * 60_000;

const CACHE = new Map<string, { name: string | null; at: number }>();

export function chatNameOf(chatId: string): string | null {
  return CACHE.get(chatId)?.name ?? null;
}

/** Chats with no cached name, or a stale one: the heartbeat's work list. */
export function chatsNeedingName(chatIds: readonly string[]): string[] {
  const now = Date.now();
  return chatIds.filter((chatId) => {
    const hit = CACHE.get(chatId);
    return hit === undefined || now - hit.at > TTL_MS;
  });
}

export function rememberChatName(chatId: string, name: string | null): void {
  CACHE.set(chatId, { name, at: Date.now() });
}
