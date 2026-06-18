// ── Business domain ──

// ── Re-export from @my-agent-team/message ──
export {
  assistantMessageId,
  deserializeLedgerContent,
  extractText,
  humanMessageId,
  isOpenMessageState,
  isTerminalMessageState,
  type Message,
  type MessageRevision,
  type MessageRole,
  type MessageState,
  mergeMessageRevision,
  parseMessageRevision,
  systemMessageId,
} from "@my-agent-team/message";

// ── Mechanism: ledger codec ──
export {
  LedgerEntry,
  LedgerKind,
  parseLedgerEntry,
  safeParseLedgerEntry,
  serializeLedgerEntry,
} from "./ledger.js";
export {
  AgentMember,
  assertAgentMember,
  assertMember,
  Conversation,
  HumanMember,
  Member,
  MemberNotFoundError,
  NotAgentMemberError,
  resolveTriggerTargets,
  TriggerMode,
} from "./member.js";
// ── Projection ──
export { projectForMember } from "./projection.js";
