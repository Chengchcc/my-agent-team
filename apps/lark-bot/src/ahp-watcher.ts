/** Watches one conversation over AHP and delivers what it says to Lark (ADR 0040).
 *
 *  The ticket gates the upgrade, the shared transport carries frames, and the official client
 *  brings the protocol: initialize hands back the chat snapshot and the subscription hands back
 *  the action stream, which the upstream chat reducer applies. The delivery table makes replaying
 *  that stream safe, so a reconnect only has to re-subscribe - there is no cursor to keep.
 *
 *  The client and the ticket fetch are injectable so the wiring can be tested without a socket.
 *  Upstream's `MultiHostClient` (its reconnect supervisor) is the next step; this loop is the
 *  same shape the SSE watcher used. */

import { type AhpClientLike, chatUri, createWebSocketTransport } from "@chengchenccc/ahp-client";
import {
  type ChatAction,
  type ChatState,
  chatReducer,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { AhpClient, type AhpTransport } from "@microsoft/agent-host-protocol/client";
import { type AhpDeliveryDeps, deliverChatState } from "./ahp-delivery.js";

export interface AhpWatcherDeps extends AhpDeliveryDeps {
  readonly backendUrl: string;
  readonly backendAuthToken: string | null;
  readonly transportFactory?: (url: string) => AhpTransport;
  readonly clientFactory?: (transport: AhpTransport) => AhpClientLike;
  readonly fetchTicket?: (
    url: string,
    headers: Record<string, string>,
  ) => Promise<{ ticket: string; wsBase: string }>;
  readonly reconnectDelayMs?: number;
}

export interface WatcherHandle {
  readonly conversationId: string;
  close: () => void;
}

export function watchConversationOverAhp(
  conversationId: string,
  larkChatId: string,
  deps: AhpWatcherDeps,
): WatcherHandle {
  const uri = chatUri(conversationId);
  const target = { conversationId, larkChatId };
  let closed = false;
  let active: AhpClientLike | undefined;

  const runOnce = async (): Promise<void> => {
    const request = deps.fetchTicket ?? defaultFetchTicket;
    const headers: Record<string, string> = {};
    if (deps.backendAuthToken) headers["x-auth-token"] = deps.backendAuthToken;
    const { ticket, wsBase } = await request(`${deps.backendUrl}/api/ahp/ws-ticket`, headers);

    const transport = (deps.transportFactory ?? createWebSocketTransport)(
      `${wsBase}/ws/ahp?ticket=${encodeURIComponent(ticket)}`,
    );
    const client = (deps.clientFactory ?? ((t: AhpTransport) => new AhpClient(t)))(transport);
    active = client;
    client.connect();

    const init = await client.initialize({
      clientId: `lark:${larkChatId}`,
      protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      initialSubscriptions: [uri],
    });
    let state = init.snapshots.find((snapshot) => snapshot.resource === uri)?.state as
      | ChatState
      | undefined;
    if (state) {
      await deliverChatState(state, target, deps);
    } else {
      console.error(`[ahp-watcher] no snapshot for ${uri}; waiting for actions`);
    }

    for await (const event of client.attachSubscription(uri)) {
      if (closed) break;
      if (event.type !== "action") continue;
      const envelope = event.params;
      if (envelope.channel !== uri) continue;
      if (!state) {
        console.error(`[ahp-watcher] action without a snapshot for ${uri}; skipping`);
        continue;
      }
      // The action union is protocol-wide; a chat channel only ever carries chat actions.
      if (!envelope.action.type.startsWith("chat/")) continue;
      state = chatReducer(state, envelope.action as ChatAction);
      await deliverChatState(state, target, deps);
    }
  };

  void (async () => {
    while (!closed) {
      try {
        await runOnce();
      } catch (err) {
        if (!closed) console.error(`[ahp-watcher] ${conversationId}:`, err);
      }
      if (closed) break;
      await Bun.sleep(deps.reconnectDelayMs ?? 1000);
    }
  })();

  return {
    conversationId,
    close: () => {
      closed = true;
      void active?.shutdown().catch(() => undefined);
    },
  };
}

async function defaultFetchTicket(
  url: string,
  headers: Record<string, string>,
): Promise<{ ticket: string; wsBase: string }> {
  const res = await fetch(url, { method: "POST", headers });
  if (!res.ok) throw new Error(`ticket request failed: ${res.status}`);
  const body: unknown = await res.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("ticket" in body) ||
    !("wsBase" in body) ||
    typeof body.ticket !== "string" ||
    typeof body.wsBase !== "string"
  ) {
    throw new Error("ticket response is not a {ticket, wsBase} body");
  }
  return { ticket: body.ticket, wsBase: body.wsBase };
}
