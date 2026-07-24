import { identityPlugin } from "@my-agent-team/plugin-identity";
import type { Capability } from "./types.js";

export const identityCapability: Capability = {
  id: "identity",
  extendAgent: ({ agentId }) => ({
    hooks: identityPlugin({ cwd: agentId }).hooks as unknown as NonNullable<
      ReturnType<Capability["extendAgent"]>
    >["hooks"],
  }),
};
