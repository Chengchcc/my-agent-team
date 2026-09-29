/** AHP 服务端核心（ADR 0040 决策二）。
 *
 *  传输无关：喂 JSON-RPC 文本，回 JSON-RPC 文本，WebSocket 层只负责搬运。
 *  上游只发客户端与纯 reducer，所以协议机械在这里；产品侧只需要注入一个状态
 *  来源（`AhpStateSource`），其余交给上游的 reducer 与可派发判定。
 *
 *  两条纪律与 ADR 0040 决策四一致：服务端的状态只由动作推进（客户端派发的动作
 *  先过 `isClientDispatchable`，越权的一律回绝并回显），产品事实不由这里写入。 */
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

export const AHP_ROOT: URI = "ahp-root://";
const SESSION_PREFIX = "ahp-session:/";
const CHAT_PREFIX = "ahp-chat:/";

const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;
const UNSUPPORTED_PROTOCOL_VERSION = -32005;
/** 上游 AhpErrorCodes：NotFound / InvalidParams / InternalError。 */
const NOT_FOUND = -32008;
const INTERNAL_ERROR = -32603;

/** 产品侧提供的状态来源。服务端只在第一次订阅某个频道时取一次，之后自己用
 *  上游 reducer 推进；产品侧的新事实通过 `dispatch` 送进来。 */
export interface AhpStateSource {
  /** 异步：真实实现要读库（agent 列表、账本投影），同步接口会逼着调用方缓存
   *  一份可能过期的快照。 */
  root(): Promise<RootState>;
  session(uri: URI): Promise<SessionState | undefined>;
  chat(uri: URI): Promise<ChatState | undefined>;
}

/** 客户端命令的落点。
 *
 *  协议模块**不解释**命令：`chat/turnStarted` 的意思是「开始一轮」，不是一次本地
 *  状态编辑，所以它不能在这里被 reducer 就地应用。产品侧收到命令，做完该做的事，
 *  再把结果作为动作派发回来（`dispatch`），两端因此仍然收敛在同一份 reducer 上。 */
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
  /** 回放缓冲能容纳多少条动作信封；差距超过它就回快照。 */
  readonly replayBufferSize?: number;
}

export interface AhpConnection {
  /** 收一帧（文本或二进制）。畸形帧被忽略，连接存活（与官方客户端一致）。 */
  handle(frame: string | Uint8Array): void;
  readonly subscriptions: ReadonlySet<URI>;
  close(): void;
}

export interface AhpServer {
  readonly serverSeq: number;
  createConnection(send: (frame: string) => void): AhpConnection;
  /** 产品侧：应用一个动作并广播给订阅该频道的连接。`origin` 用于把客户端命令
   *  的结果回显给它自己。返回分发的信封。 */
  dispatch(uri: URI, action: StateAction, origin?: ActionOrigin): Promise<ActionEnvelope>;
}

interface ConnectionState {
  readonly send: (frame: string) => void;
  readonly subscriptions: Set<URI>;
  initialized: boolean;
  closed: boolean;
  /** 客户端身份，来自 initialize：回显它的动作时用作信封来源。 */
  clientId?: string;
}

export function createAhpServer(opts: AhpServerOptions): AhpServer {
  const states = new Map<URI, unknown>();
  const connections = new Set<ConnectionState>();
  const buffer: ActionEnvelope[] = [];
  const cap = opts.replayBufferSize ?? 512;
  let serverSeq = 0;

  /** 我们提供三类频道：root / session / chat（ADR 0040 的范围）。其余一律不服务。 */
  const isServed = (uri: URI): boolean =>
    uri === AHP_ROOT || uri.startsWith(SESSION_PREFIX) || uri.startsWith(CHAT_PREFIX);

  /** 频道不可用。**不能**退化成空状态：空状态会被缓存，之后所有动作都在伪造的
   *  初始值上 reduce，客户端还以为自己订阅到了东西。 */
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
        : uri.startsWith(SESSION_PREFIX)
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
    if (uri.startsWith(SESSION_PREFIX)) {
      states.set(uri, sessionReducer(state as SessionState, action as never));
      return;
    }
    if (uri.startsWith(CHAT_PREFIX)) {
      states.set(uri, chatReducer(state as ChatState, action as never));
    }
    // 其余频道（terminal / changeset / annotations / automation / otlp）本轮不做。
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
        // 先取快照再登记订阅：取不到就报错，且不要留下一条订阅不到东西的登记。
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
        // 差距在缓冲内就放动作，超出就回快照（重放成本不随断线时长无上限）。
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
          // 越权动作必须回显并带原因，客户端才能回滚它的乐观更新。
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
        // 交给产品侧：它做出事实变化，再用 dispatch 把结果广播回来。协议模块
        // 自己不动这根频道的状态，否则客户端的乐观写入会被当成服务端事实。
        // 先包进 promise 再调用：端口同步抛错时也要走同一条回绝路径，不能把
        // 帧处理炸掉。
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
          return; // 畸形帧忽略，连接存活
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
