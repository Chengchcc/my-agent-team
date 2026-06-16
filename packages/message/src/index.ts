export type {
  Message,
  MessageAuthor,
  MessageError,
  MessageRole,
  MessageState,
  MessageToolState,
} from "./message.js";
export type { MessageRevision } from "./revision.js";
export {
  assistantMessageId,
  isOpenMessageState,
  isTerminalMessageState,
  mergeMessageRevision,
} from "./helpers.js";
