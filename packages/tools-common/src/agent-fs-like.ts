/** M17.5: Re-export canonical AgentFsLike from @my-agent-team/core.
 *  The canonical definition lives in core (L1 primitive, same layer as Tool/Message).
 *  This re-export avoids breaking all consumers at once; new imports should go to core directly. */
export { type AgentFsLike, pjoin } from "@my-agent-team/core";
