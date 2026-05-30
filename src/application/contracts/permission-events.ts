// ── permission.required ───────────────────────────────────────────────────────

export interface PermissionRequiredV1 {
  reqId: string;
  toolName: string;
  sessionId: string;
  input?: unknown;
  cwd?: string;
  inputTruncated?: boolean;
  description?: string;
}

// ── permission.resolved ───────────────────────────────────────────────────────

export interface PermissionResolvedV1 {
  reqId: string;
  approved: boolean;
  sessionId: string;
  scope?: 'once' | 'always';
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
