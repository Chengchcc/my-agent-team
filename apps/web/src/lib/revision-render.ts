import {
  isOpenMessageState,
  isTerminalMessageState,
  type Message,
  type MessageRevision,
} from "@my-agent-team/message";

export function getRevisionText(rev: MessageRevision | Message): string {
  return rev.text ?? "";
}

export type { ContentBlock } from "@my-agent-team/message";
export { isOpenMessageState, isTerminalMessageState };
