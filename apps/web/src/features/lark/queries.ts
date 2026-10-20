import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** One bound chat as the bot reports it (diagnostics heartbeat ->
 *  runtime-ops `surfaces.lark.chats`; the bot's SQLite stays the authority,
 *  the backend only mirrors it). */
export type BoundChat = {
  chatId: string;
  /** Resolved by the bot from the OpenAPI; null until the lookup lands, and
   *  the UI then falls back to the id. */
  chatName?: string | null;
  chatType: string | null;
  chatMode: string | null;
  conversations: number;
  topicRootMessageId: string | null;
};

/** Narrow the open-ended surface payload without trusting it: the field is
 *  `unknown[]` on the wire, so anything malformed is dropped rather than
 *  rendered as "undefined". */
export function boundChatsOf(runtime: unknown): BoundChat[] {
  if (typeof runtime !== "object" || runtime === null) return [];
  const surfaces = (runtime as { surfaces?: unknown }).surfaces;
  if (typeof surfaces !== "object" || surfaces === null) return [];
  const lark = (surfaces as Record<string, unknown>).lark;
  if (typeof lark !== "object" || lark === null) return [];
  const chats = (lark as { chats?: unknown }).chats;
  if (!Array.isArray(chats)) return [];
  return chats.filter((c): c is BoundChat => {
    if (typeof c !== "object" || c === null) return false;
    const row = c as { chatId?: unknown };
    return typeof row.chatId === "string" && row.chatId.length > 0;
  });
}

export const larkKeys = {
  surface: (agentId: string) => ["lark", "surface", agentId] as const,
};

/** The surface read model, polled only while it is still moving: authorizing
 *  and starting are the two states that change without user action, so a
 *  settled surface costs one request, not a heartbeat. */
export function larkSurfaceQuery(agentId: string) {
  return queryOptions({
    queryKey: larkKeys.surface(agentId),
    queryFn: () => api.larkSurface(agentId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "authorizing" || status === "starting") return 3000;
      return false;
    },
  });
}
