// ── permission.required ───────────────────────────────────────────────────────

export interface PermissionRequiredV1 {
  reqId: string;
  toolName: string;
  sessionId: string;
}

// ── permission.resolved ───────────────────────────────────────────────────────

export interface PermissionResolvedV1 {
  reqId: string;
  approved: boolean;
  sessionId: string;
}

// ── ask-user-question.required ────────────────────────────────────────────────

export interface AskUserQuestionRequiredV1 {
  questionId: string;
  sessionId: string;
  question: string;
  options: string[];
}

// ── ask-user-question.resolved ────────────────────────────────────────────────

export interface AskUserQuestionResolvedV1 {
  questionId: string;
  sessionId: string;
  answer: string;
}
