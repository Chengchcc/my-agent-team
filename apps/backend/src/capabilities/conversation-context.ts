import { conversationContextPlugin } from "@my-agent-team/plugin-conversation-context";
import type { Capability } from "./types.js";

export const conversationContextCapability: Capability = {
  id: "conversation-context",
  extendAgent: () => ({
    hooks: conversationContextPlugin({}).hooks as unknown as NonNullable<
      ReturnType<Capability["extendAgent"]>
    >["hooks"],
  }),
};
