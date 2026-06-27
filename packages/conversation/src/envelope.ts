import type { MessageRevision } from "@my-agent-team/message";
import type { RunStatus } from "./run-status.js";

/** SSE event payload — allows consumers to distinguish message content
 *  from transient run lifecycle status without parsing heuristics. */
export type ConversationFrame =
  | { type: "message_revision"; seq: number; spanId: string; revision: MessageRevision }
  | { type: "run_status"; seq: number; spanId: string; status: RunStatus };
