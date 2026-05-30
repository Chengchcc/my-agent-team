import { useCallback, useEffect, useState } from 'react';

export interface AskUserQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multi_select: boolean;
}

export type AskUserQuestionResult =
  | { cancelled: true }
  | { cancelled?: false; answers: Array<{ question_index: number; selected_labels: string[] }> };

export interface AskUserQuestionRequest {
  questions: AskUserQuestionItem[];
}

interface Pending {
  request: AskUserQuestionRequest;
  resolve: (r: AskUserQuestionResult) => void;
}

const listeners = new Set<(p: Pending | null) => void>();
let queue: Pending[] = [];

function notify() {
  const current = queue[0] ?? null;
  listeners.forEach(fn => fn(current));
}

export function _enqueueAskUserQuestion(req: AskUserQuestionRequest): Promise<AskUserQuestionResult> {
  return new Promise((resolve) => {
    queue.push({ request: req, resolve });
    if (queue.length === 1) notify(); // only notify if first in queue
  });
}

export function useAskUserQuestionManager() {
  const [pending, setPending] = useState<Pending | null>(queue[0] ?? null);

  useEffect(() => {
    const fn = (p: Pending | null) => setPending(p);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  const respond = useCallback((r: AskUserQuestionResult) => {
    const p = queue.shift();
    if (!p) return;
    p.resolve(r);
    notify(); // show next in queue
  }, []);

  const dismiss = useCallback(() => respond({ cancelled: true }), [respond]);

  return { pending, respond, dismiss };
}

/** Test-only: force-resolve the current pending ask-user-question request. */
export function _respondAskUserQuestionForTest(r: AskUserQuestionResult): void {
  const p = queue.shift();
  if (!p) return;
  p.resolve(r);
  notify();
}
