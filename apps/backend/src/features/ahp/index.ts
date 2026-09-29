/** AHP 面（ADR 0040）：协议机械、状态投影与 WebSocket 传输。
 *
 *  对外只有三件事：`createAhpServer`（传输无关的协议核心）、
 *  `createAhpStateSource`（产品只读投影）、`createAhpFace`（挂到 Elysia 的 WS 路由）。 */

export {
  AHP_CHAT_PREFIX,
  AHP_ROOT_URI,
  AHP_SESSION_PREFIX,
  chatUri,
  conversationIdFrom,
  sessionUri,
} from "@chengchenccc/ahp-client";
export type { AhpFace, AhpFaceOptions } from "./http.js";
export { createAhpFace } from "./http.js";
export type {
  AhpCommandPort,
  AhpConnection,
  AhpServer,
  AhpServerOptions,
  AhpStateSource,
} from "./protocol.js";
export {
  AHP_ROOT,
  createAhpServer,
} from "./protocol.js";
export type {
  AhpAgentRow,
  AhpConversationRow,
  AhpLedgerRow,
  AhpRunRow,
  AhpStateSourceDeps,
} from "./state-source.js";
export { createAhpStateSource } from "./state-source.js";
