/** The AHP face (ADR 0040): protocol machinery, state projection and the WebSocket transport.
 *
 *  Three things are public: `createAhpServer` (the transport-agnostic core),
 *  `createAhpStateSource` (the product's read-only projection) and `createAhpHost` (the ws mount). */

export {
  AHP_CHAT_PREFIX,
  AHP_ROOT_URI,
  AHP_SESSION_PREFIX,
  chatUri,
  conversationIdFrom,
  sessionUri,
} from "@chengchenccc/ahp-client";
export type { AhpHost, AhpHostOptions } from "./http.js";
export { createAhpHost } from "./http.js";
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
