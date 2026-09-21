/** Loop mode: re-submit the last prompt after every settled turn, optionally
 *  bounded by an iteration count or a wall-clock duration. Limits + their
 *  parsing live in limits.ts; the session-scoped state machine in
 *  runtime.ts. */

export {
  DEFAULT_CONDITION_TIMEOUT_MS,
  describeLoopCondition,
  evaluateLoopCondition,
  type LoopConditionConfig,
  type LoopConditionOptions,
  type LoopConditionVerdict,
} from "./condition.js";
export {
  consumeLoopLimitIteration,
  createLoopLimitRuntime,
  describeLoopLimit,
  describeLoopLimitRuntime,
  isLoopDurationExpired,
  LOOP_USAGE,
  type LoopLimitConfig,
  type LoopLimitRuntime,
  type ParsedLoopArgs,
  parseLoopArgs,
} from "./limits.js";
export {
  type LoopAction,
  type LoopIterationDecision,
  LoopRuntime,
  type LoopStart,
  type LoopStatus,
} from "./runtime.js";
