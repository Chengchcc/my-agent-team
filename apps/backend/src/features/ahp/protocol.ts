/** The AHP server core (ADR 0040, decision 2).
 *
 *  Transport-agnostic: JSON-RPC text in, JSON-RPC text out - the WebSocket layer only carries.
 *  Upstream ships a client and pure reducers, so the protocol machinery lives here; the product
 *  side injects a state source (`AhpStateSource`) and leaves the rest to those reducers and the
 *
 *  dispatchability check. Two disciplines, both from ADR 0040 decision 4: server state advances
 *  only through actions (client-dispatched ones pass `isClientDispatchable` first, and an
 *  overreach is reflected back with a reason), and product facts are never written here. */

import { AHP_CHAT_PREFIX, AHP_ROOT_URI, AHP_SESSION_PREFIX } from "@chengchenccc/ahp-client";
import {
  type ActionEnvelope,
  type ActionOrigin,
  type ChatState,
  chatReducer,
  isClientDispatchable,
  type RootState,
  rootReducer,
  type SessionState,
  type Snapshot,
  type StateAction,
  SUPPORTED_PROTOCOL_VERSIONS,
  sessionReducer,
  type URI,
} from "@microsoft/agent-host-protocol";

/** The root channel literal: the same string the surfaces use (`@chengchenccc/ahp-client`). */
export const AHP_ROOT: URI = AHP_ROOT_URI;

const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;
const UNSUPPORTED_PROTOCOL_VERSION = -32005;
/** Upstream AhpErrorCodes: NotFound / InvalidParams / InternalError. */
const NOT_FOUND = -32008;
const INTERNAL_ERROR = -32603;

/** The state source the product provides. The server fetches a channel's state once, on the
 *  first subscription, and advances it with upstream reducers after that; new product facts
 *  arrive through `dispatch`. */
export interface AhpStateSource {
  /** Async on purpose: a real implementation reads the database (agent list, ledger projection),
   *  and a sync signature would force callers to cache a snapshot that may already be stale. */
  root(): Promise<RootState>;
  session(uri: URI): Promise<SessionState | undefined>;
  chat(uri: URI): Promise<ChatState | undefined>;
}

/** Where client commands land.
 *
 *  The protocol module does **not** interpret commands: `chat/turnStarted` means "start a turn",
 *  not a local state edit, so it cannot be applied in place by a reducer here. The product side
 *  takes the command, does what it takes, and dispatches the result back - which is how both ends
 *  stay converged on the same reducer. */
export interface AhpCommandPort {
  submit(command: {
    readonly channel: URI;
    readonly action: StateAction;
    readonly origin: ActionOrigin;
  }): void | Promise<void>;
}

export interface AhpServerOptions {
  readonly source: AhpStateSource;
  readonly commands: AhpCommandPort;
  readonly serverInfo?: { readonly name: string; readonly version: string };
  /** How many action envelopes the replay buffer holds; a bigger gap falls back to a snapshot. */
  readonly replayBufferSize?: number;
}

export interface AhpConnection {
  /** Take one frame (text or binary). A malformed frame is ignored; the connection survives. */
  handle(frame: string | Uint8Array): void;
  readonly subscriptions: ReadonlySet<URI>;
  close(): void;
}

export interface AhpServer {
  readonly serverSeq: number;
  createConnection(send: (frame: string) => void): AhpConnection;
  /** Product side: apply an action and broadcast it to the connections subscribed to its channel.
   *  `origin` echoes the result of a client command back to that client. Returns the envelope. */
  dispatch(uri: URI, action: StateAction, origin?: ActionOrigin): Promise<ActionEnvelope>;
}

interface ConnectionState {
  readonly send: (frame: string) => void;
  readonly subscriptions: Set<URI>;
  initialized: boolean;
  closed: boolean;
  /** The client identity from initialize, used as the envelope origin when echoing its actions. */
  clientId?: string;
}

export function createAhpServer(opts: AhpServerOptions): AhpServer {
  const states = new Map<URI, unknown>();
  const connections = new Set<ConnectionState>();
  const buffer: ActionEnvelope[] = [];
  const cap = opts.replayBufferSize ?? 512;
  let serverSeq = 0;

  /** We serve three channel kinds - root / session / chat (ADR 0040's scope). Nothing else. */
  const isServed = (uri: URI): boolean =>
    uri === AHP_ROOT || uri.startsWith(AHP_SESSION_PREFIX) || uri.startsWith(AHP_CHAT_PREFIX);

  /** The channel is unavailable. It must **not** degrade to an empty state: that state gets
   *  cached, every later action reduces against a fabricated initial value, and the client
   *  believes it subscribed to something. */
  class ChannelUnavailableError extends Error {
    readonly code: number;
    constructor(code: number, message: string) {
      super(message);
      this.code = code;
    }
  }

  const codeOf = (err: unknown): number =>
    err instanceof ChannelUnavailableError ? err.code : INTERNAL_ERROR;
  const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  const seed = async (uri: URI): Promise<unknown> => {
    const known = states.get(uri);
    if (known !== undefined) return known;
    if (!isServed(uri)) {
      throw new ChannelUnavailableError(INVALID_PARAMS, `channel not served: ${uri}`);
    }
    const fromSource =
      uri === AHP_ROOT
        ? await opts.source.root()
        : uri.startsWith(AHP_SESSION_PREFIX)
          ? await opts.source.session(uri)
          : await opts.source.chat(uri);
    if (fromSource === undefined) {
      throw new ChannelUnavailableError(NOT_FOUND, `no such resource: ${uri}`);
    }
    states.set(uri, fromSource);
    return fromSource;
  };

  const snapshotOf = async (uri: URI): Promise<Snapshot> => ({
    resource: uri,
    state: (await seed(uri)) as Snapshot["state"],
    fromSeq: serverSeq,
  });

  const reduce = (uri: URI, state: unknown, action: StateAction): void => {
    if (uri === AHP_ROOT) {
      states.set(uri, rootReducer(state as RootState, action as never));
      return;
    }
    if (uri.startsWith(AHP_SESSION_PREFIX)) {
      states.set(uri, sessionReducer(state as SessionState, action as never));
      return;
    }
    if (uri.startsWith(AHP_CHAT_PREFIX)) {
      states.set(uri, chatReducer(state as ChatState, action as never));
    }
    // Other channels (terminal / changeset / annotations / automation / otlp) are out of scope.
  };

  const fanOut = (envelope: ActionEnvelope): void => {
    const frame = JSON.stringify({ jsonrpc: "2.0", method: "action", params: envelope });
    for (const connection of connections) {
      if (connection.closed) continue;
      if (connection.subscriptions.has(envelope.channel)) connection.send(frame);
    }
  };

  const dispatchWith = async (
    uri: URI,
    action: StateAction,
    origin: ActionOrigin | undefined,
  ): Promise<ActionEnvelope> => {
    const state = await seed(uri);
    serverSeq += 1;
    const envelope: ActionEnvelope = { channel: uri, action, serverSeq, origin };
    reduce(uri, state, action);
    buffer.push(envelope);
    if (buffer.length > cap) buffer.splice(0, buffer.length - cap);
    fanOut(envelope);
    return envelope;
  };
  const dispatch = (uri: URI, action: StateAction, origin?: ActionOrigin) =>
    dispatchWith(uri, action, origin);

  const server: AhpServer = {
    get serverSeq() {
      return serverSeq;
    },
    dispatch,
    createConnection(send) {
      const connection: ConnectionState = {
        send,
        subscriptions: new Set(),
        initialized: false,
        closed: false,
      };
      connections.add(connection);

      const respond = (id: unknown, result: unknown): void => {
        send(JSON.stringify({ jsonrpc: "2.0", id, result }));
      };
      const fail = (id: unknown, code: number, message: string, data?: unknown): void => {
        send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code, message, ...(data ? { data } : {}) },
          }),
        );
      };

      const onInitialize = async (id: unknown, params: Record<string, unknown>): Promise<void> => {
        if (connection.initialized) {
          fail(id, INVALID_REQUEST, "initialize may only be sent once");
          return;
        }
        const offered = params.protocolVersions;
        const subscriptions = params.initialSubscriptions;
        if (
          params.channel !== AHP_ROOT ||
          typeof params.clientId !== "string" ||
          !Array.isArray(offered)
        ) {
          fail(
            id,
            INVALID_PARAMS,
            "initialize needs channel=ahp-root://, clientId and protocolVersions",
          );
          return;
        }
        const selected = (offered as unknown[]).find(
          (version): version is string =>
            typeof version === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(version as never),
        );
        if (selected === undefined) {
          fail(id, UNSUPPORTED_PROTOCOL_VERSION, "no offered protocol version is supported", {
            supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          });
          return;
        }
        connection.initialized = true;
        connection.clientId = params.clientId;
        const toSubscribe = Array.isArray(subscriptions)
          ? subscriptions.filter((uri): uri is URI => typeof uri === "string")
          : [];
        // Snapshot first, register second: a failure must not leave a dead subscription behind.
        let snapshots: Snapshot[];
        try {
          snapshots = await Promise.all(toSubscribe.map(snapshotOf));
        } catch (err) {
          fail(id, codeOf(err), messageOf(err));
          return;
        }
        for (const uri of toSubscribe) connection.subscriptions.add(uri);
        respond(id, {
          protocolVersion: selected,
          serverSeq,
          ...(opts.serverInfo ? { serverInfo: opts.serverInfo } : {}),
          snapshots,
        });
      };

      const onSubscribe = async (id: unknown, params: Record<string, unknown>): Promise<void> => {
        const uri = params.channel;
        if (typeof uri !== "string") {
          fail(id, INVALID_PARAMS, "subscribe needs a channel");
          return;
        }
        try {
          const snapshot = await snapshotOf(uri);
          connection.subscriptions.add(uri);
          respond(id, { snapshot });
        } catch (err) {
          fail(id, codeOf(err), messageOf(err));
        }
      };

      const onReconnect = async (id: unknown, params: Record<string, unknown>): Promise<void> => {
        const subscriptions = params.subscriptions;
        const uris = Array.isArray(subscriptions)
          ? subscriptions.filter((uri): uri is URI => typeof uri === "string")
          : [];
        const lastSeen =
          typeof params.lastSeenServerSeq === "number" ? params.lastSeenServerSeq : 0;
        const missed = buffer.filter((envelope) => envelope.serverSeq > lastSeen);
        // A gap inside the buffer replays actions; beyond it, fall back to a snapshot.
        const canReplay =
          buffer.length === 0
            ? lastSeen === serverSeq
            : missed.length > 0 && missed[0]!.serverSeq === lastSeen + 1;
        if (canReplay) {
          for (const uri of uris) connection.subscriptions.add(uri);
          respond(id, { type: "replay", actions: missed, missing: [] });
          return;
        }
        let snapshots: Snapshot[];
        try {
          snapshots = await Promise.all(uris.map(snapshotOf));
        } catch (err) {
          fail(id, codeOf(err), messageOf(err));
          return;
        }
        for (const uri of uris) connection.subscriptions.add(uri);
        respond(id, { type: "snapshot", snapshots });
      };

      const onDispatchAction = (params: Record<string, unknown>): void => {
        const uri = params.channel;
        const action = params.action as StateAction | undefined;
        if (typeof uri !== "string" || action === undefined) return;
        const origin: ActionOrigin = {
          clientId: connection.clientId ?? "",
          clientSeq: typeof params.clientSeq === "number" ? params.clientSeq : 0,
        };
        if (!isClientDispatchable(action as never)) {
          // An overreach must be reflected back with a reason so the client can roll back.
          connection.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "action",
              params: {
                channel: uri,
                action,
                serverSeq,
                origin,
                rejectionReason: "action is not client-dispatchable",
              },
            }),
          );
          return;
        }
        // Hand it to the product side: that side makes the fact happen and dispatches the result
        // back. This module never edits the channel's state itself, or a client's optimistic write
        // would become a server fact. Wrap before calling too: a port that throws synchronously
        // must take the same rejection path instead of blowing up frame handling.
        void Promise.resolve()
          .then(() => opts.commands.submit({ channel: uri, action, origin }))
          .catch((err: unknown) => {
            connection.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "action",
                params: {
                  channel: uri,
                  action,
                  serverSeq,
                  origin,
                  rejectionReason: err instanceof Error ? err.message : String(err),
                },
              }),
            );
          });
      };

      const handle = (frame: string | Uint8Array): void => {
        if (connection.closed) return;
        const text = typeof frame === "string" ? frame : new TextDecoder().decode(frame);
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return; // malformed frame: ignore it, the connection survives
        }
        const method = message.method;
        if (typeof method !== "string") return;
        const params = (message.params ?? {}) as Record<string, unknown>;
        const id = message.id;
        const isRequest = typeof id === "number" || typeof id === "string";

        if (method === "dispatchAction") {
          onDispatchAction(params);
          return;
        }
        if (method === "unsubscribe") {
          if (typeof params.channel === "string") connection.subscriptions.delete(params.channel);
          return;
        }
        if (!isRequest) return;

        switch (method) {
          case "initialize":
            void onInitialize(id, params);
            return;
          case "subscribe":
            void onSubscribe(id, params);
            return;
          case "reconnect":
            void onReconnect(id, params);
            return;
          case "ping":
            respond(id, null);
            return;
          default:
            fail(id, METHOD_NOT_FOUND, `unknown method: ${method}`);
        }
      };

      return {
        handle,
        get subscriptions() {
          return connection.subscriptions as ReadonlySet<URI>;
        },
        close() {
          connection.closed = true;
          connections.delete(connection);
        },
      };
    },
  };

  return server;
}
