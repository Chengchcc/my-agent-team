// System-level event contracts for controlplane-emitted events.

export interface AttachChangedV1 {
  frontendId: string;
  sessionId: string;
  action: 'attached' | 'detached';
}

export interface SessionResumedV1 {
  sessionId: string;
  frontendId?: string;
  previousSessionId: string | null;
}

export interface SessionClosedV1 {
  sessionId: string;
  force: boolean;
}

export interface SessionRenamedV1 {
  sessionId: string;
  title: string;
}

export interface UserQuestionAnsweredV1 {
  sessionId: string;
  questionId: string;
  answers: Array<{ question_index: number; selected_labels: string[] }>;
}

export interface SystemShutdownRequestedV1 {
  agentId: string;
  timestamp: string;
}

export interface InputCancelledV1 {
  sessionId: string;
  reason: string;
}

export interface TurnCancelledV1 {
  sessionId: string;
  reason: string;
}
