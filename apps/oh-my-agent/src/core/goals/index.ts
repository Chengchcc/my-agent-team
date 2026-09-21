/** Goal mode (omp goals/ port): the session's persistent autonomous
 *  objective — state machine + prompts (state.ts), the runtime that owns
 *  accounting and loop decisions (runtime.ts), and the model-facing tool
 *  (tool.ts). */

export {
  type GoalLoopDecision,
  GoalRuntime,
  type GoalTurnUsage,
  type SettledTurn,
} from "./runtime.js";
export {
  accountTurn,
  accrueUsage,
  budgetLimitedGoal,
  canCreateGoal,
  completeGoal,
  completionBudgetReport,
  createGoal,
  dropGoal,
  type Goal,
  type GoalModeState,
  type GoalPromptKind,
  type GoalStatus,
  goalTokenDelta,
  isAccountingStatus,
  pauseGoal,
  remainingTokens,
  renderGoalPrompt,
  renderInterviewPrompt,
  resumeGoal,
  validateTokenBudget,
} from "./state.js";
export { createGoalPlugin, createGoalTool } from "./tool.js";
