/** Connects a web surface to the backend's AHP face (ADR 0040: the surface contract is AHP).
 *
 *  The ticket comes through the BFF - a browser cannot set headers on a WebSocket handshake -
 *  the shared transport carries frames, and the official client brings the protocol: initialize
 *  returns the chat snapshot and the subscription returns the action stream, which upstream's
 *  chat reducer applies. No cursor is kept: a reconnect only has to re-subscribe. */

import { type AhpClientLike, chatUri, createWebSocketTransport } from "@chengchenccc/ahp-client";
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
    let client: AhpClientLike | undefined;
    let stopped = false;
    // Every round owns its client. Whatever ends it — an error, the stream
    // closing, a failed subscribe — the socket and its subscriptions are
    // released here, so a reconnect cannot leave the previous one running.
    const stopClient = async (): Promise<void> => {
      if (client === undefined || stopped) return;
      stopped = true;
      if (active === client) active = undefined;
      await client.shutdown().catch(() => undefined);
    };
    try {
      await runRound();
    } finally {
      await stopClient();
    }

    async function runRound(): Promise<void> {
      const request = deps.fetchTicket ?? defaultFetchTicket;
      const { ticket, wsBase } = await request();
      // A ticket request is a network round trip: the surface can be gone before
      // it answers. Connecting anyway left a live socket and subscription that
      // nothing would ever shut down (close() had already run and found no
      // client to stop) — measured with a deterministic probe, audit 2026-11-24.
      if (closed) return;
      const transport = (deps.transportFactory ?? createWebSocketTransport)(
        `${wsBase}/ws/ahp?ticket=${encodeURIComponent(ticket)}`,
      );
      client = (deps.clientFactory ?? ((t: AhpTransport) => new AhpClient(t)))(transport);
      active = client;
      if (closed) return;
      client.connect();

      // Same window again: initialize is awaited before the first snapshot.
      if (closed) return;
      const init = await client.initialize({
        clientId: deps.clientId ?? "web",
        protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        // Chat only. Root used to ride along, but nothing here reads its
        // snapshot and nothing dispatches root actions (#56): the agent UI is
        // React-Query-backed and invalidated on every agent mutation, so a root
        // subscription was dead weight on every conversation connection.
        initialSubscriptions: [uri],
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
        // A DB-only fact -- the plan strip, a commit_failed transition, an undo -- has no action to
        // carry it, so the host dropped this channel's cached projection. A tool having completed is
        // exactly when such a write may have landed, so re-read instead of painting a stale strip
        // until the next reconnect (#52). The carrier subscription is closed immediately: the state
        // is taken from its response, not from its stream.
        if (envelope.action.type === "chat/toolCallComplete") {
          const reply = await client.subscribe(uri);
          const fresh = reply.result?.snapshot?.state as ChatState | undefined;
          if (fresh) {
            state = fresh;
            deps.onChange(state);
          }
          await reply.subscription.close();
        }
      }
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
