/** Connects a web surface to the backend's AHP face (ADR 0040: the surface contract is AHP).
 *
 *  The ticket comes through the BFF - a browser cannot set headers on a WebSocket handshake -
 *  the shared transport carries frames, and the official client brings the protocol: initialize
 *  returns the chat snapshot and the subscription returns the action stream, which upstream's
 *  chat reducer applies. No cursor is kept: a reconnect only has to re-subscribe. */

import {
  AHP_ROOT_URI,
  type AhpClientLike,
  chatUri,
  createWebSocketTransport,
} from "@chengchenccc/ahp-client";
import {
  type ChatAction,
  type ChatState,
  chatReducer,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { AhpClient, type AhpTransport } from "@microsoft/agent-host-protocol/client";

export interface AhpChatDeps {
  readonly conversationId: string;
  readonly onChange: (state: ChatState) => void;
  readonly onError?: (error: unknown) => void;
  readonly clientId?: string;
  readonly reconnectDelayMs?: number;
  /** Injectable seams, so the wiring is tested without a socket. */
  readonly fetchTicket?: () => Promise<{ ticket: string; wsBase: string }>;
  readonly transportFactory?: (url: string) => AhpTransport;
  readonly clientFactory?: (transport: AhpTransport) => AhpClientLike;
}

export interface AhpChatConnection {
  close(): void;
}

export function connectAhpChat(deps: AhpChatDeps): AhpChatConnection {
  const uri = chatUri(deps.conversationId);
  let closed = false;
  let active: AhpClientLike | undefined;

  const runOnce = async (): Promise<void> => {
    const request = deps.fetchTicket ?? defaultFetchTicket;
    const { ticket, wsBase } = await request();
    const transport = (deps.transportFactory ?? createWebSocketTransport)(
      `${wsBase}/ws/ahp?ticket=${encodeURIComponent(ticket)}`,
    );
    const client = (deps.clientFactory ?? ((t: AhpTransport) => new AhpClient(t)))(transport);
    active = client;
    client.connect();

    const init = await client.initialize({
      clientId: deps.clientId ?? "web",
      protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      initialSubscriptions: [AHP_ROOT_URI, uri],
    });
    let state = init.snapshots.find((snapshot) => snapshot.resource === uri)?.state as
      | ChatState
      | undefined;
    if (state) deps.onChange(state);

    for await (const event of client.attachSubscription(uri)) {
      if (closed) break;
      if (event.type !== "action") continue;
      const envelope = event.params;
      if (envelope.channel !== uri) continue;
      if (!state) continue;
      // The action union is protocol-wide; a chat channel only ever carries chat actions.
      if (!envelope.action.type.startsWith("chat/")) continue;
      state = chatReducer(state, envelope.action as ChatAction);
      deps.onChange(state);
    }
  };

  void (async () => {
    while (!closed) {
      try {
        await runOnce();
      } catch (err) {
        if (!closed) deps.onError?.(err);
      }
      if (closed) break;
      await new Promise((resolve) => setTimeout(resolve, deps.reconnectDelayMs ?? 1000));
    }
  })();

  return {
    close: () => {
      closed = true;
      void active?.shutdown().catch(() => undefined);
    },
  };
}

async function defaultFetchTicket(): Promise<{ ticket: string; wsBase: string }> {
  const res = await fetch("/api/bff/api/ahp/ws-ticket", { method: "POST", credentials: "include" });
  if (!res.ok) throw new Error(`ticket request failed: ${res.status}`);
  return (await res.json()) as { ticket: string; wsBase: string };
}
