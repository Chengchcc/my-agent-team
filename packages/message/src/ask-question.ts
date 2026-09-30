/** ask_question tool protocol (oh-my-pi style questions; select + text kinds). */

export interface AskQuestionOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface AskQuestionValidation {
  /** default true */
  required?: boolean;
  /** text only */
  minLength?: number;
  /** text only */
  maxLength?: number;
  /** multi select only */
  minSelections?: number;
  /** multi select only */
  maxSelections?: number;
}

export interface AskQuestionItem {
  id: string;
  /** "select" = options picker; "text" = free input. Default "select". */
  kind: "select" | "text";
  question: string;
  /** grouping header shown above the question */
  header?: string;

  // ── select only ──
  multi?: boolean;
  options?: AskQuestionOption[];
  /** option.value to badge as (Recommended) */
  recommended?: string;
  /** show an "Other (type your own)" free-text row */
  allowOther?: boolean;
  /** offer "Chat about this" instead of answering the form */
  allowChat?: boolean;

  // ── text only ──
  placeholder?: string;
  /** textarea instead of single-line input */
  multiline?: boolean;

  validation?: AskQuestionValidation;
}

export interface AskQuestionInput {
  questions: AskQuestionItem[];
}

export interface AskQuestionAnswerItem {
  id: string;
  /** selected option values (select kind) */
  selectedValues: string[];
  /** free text (text kind, or the "Other" row on select kind) */
  freeText?: string;
  /** Note the user attached to a specific option row (oh-my-pi's `n` key).
   *  Belongs to the row it was written on, so it survives only while that row
   *  is the answer. */
  note?: string;
  /** True when this answer was auto-selected because the ask timed out rather
   *  than chosen by the user. The model must be told: an auto-selected option
   *  is not consent (oh-my-pi's `timedOut`). */
  timedOut?: boolean;
}

export interface AskQuestionResult {
  answers: AskQuestionAnswerItem[];
}

/** Structured message kept in the conversation after the user submits. */
export interface AskQuestionFilled {
  kind: "ask_question_filled";
  answers: AskQuestionAnswerItem[];
}
