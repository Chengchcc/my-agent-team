import type { ToolContext } from '../../application/ports/tool-context';
import type { AskUserQuestionArgs } from '../../application/contracts/tool-schemas/ask-user-question';

/** @public — tool result schema, consumed by LLM */
export interface AskUserQuestionAnswer {
  question_index: number;
  selected_labels: string[];
}

// ── Execute ──

export async function askUserQuestionExecute(
  args: AskUserQuestionArgs,
  _ctx: ToolContext,
): Promise<unknown> {
  return { content: `User question not yet available. Questions: ${args.questions.length}`, isError: true };
}
