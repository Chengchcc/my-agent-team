import { progressiveSkillPlugin } from "@my-agent-team/plugin-progressive-skill";
import type { Capability } from "./types.js";

export const progressiveSkillCapability: Capability = {
  id: "progressive-skill",
  extendAgent: ({ agentId }) => ({
    hooks: progressiveSkillPlugin({ cwd: agentId }).hooks as unknown as NonNullable<
      ReturnType<Capability["extendAgent"]>
    >["hooks"],
  }),
};
