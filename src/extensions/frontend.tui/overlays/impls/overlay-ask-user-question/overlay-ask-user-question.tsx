// src/extensions/frontend.tui/overlays/impls/overlay-ask-user-question/overlay-ask-user-question.tsx
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AskUserQuestionItem, AskUserQuestionRequest, AskUserQuestionResult } from './use-ask-user-question-manager';
import { useAskUserQuestionManager } from './use-ask-user-question-manager';
import type { KeyDispatcher } from '../../../input/key-dispatcher';
import type { OverlayDescriptor } from '../../overlay-types';

function buildInitialSelections(questions: AskUserQuestionItem[]): string[][] {
  return questions.map((q) => (q.multi_select ? [] : [q.options[0]!.label]));
}

function buildInitialFocus(questions: AskUserQuestionItem[]): number[] {
  return questions.map(() => 0);
}

function canSubmit(questions: AskUserQuestionItem[], selections: string[][]): boolean {
  return questions.every((q, i) => {
    const s = selections[i]!;
    if (q.multi_select) return s.length >= 1;
    return s.length === 1;
  });
}

const MAX_TAB_LABEL_LENGTH = 12;
const TAB_LABEL_TRUNCATION_LENGTH = 11;

function tabLabel(header: string): string {
  return header.length > MAX_TAB_LABEL_LENGTH ? `${header.slice(0, TAB_LABEL_TRUNCATION_LENGTH)}…` : header;
}

// ── Key handler builder for the ask-user-question overlay ──────────────────

interface QuestionState {
  tabIndex: number;
  selections: string[][];
  focusIdx: number[];
  questions: AskUserQuestionItem[];
  qCount: number;
  reviewTabIndex: number;
  respond: (answer: AskUserQuestionResult) => void;
}

interface QuestionKeyLayerDeps {
  keyDispatcher: KeyDispatcher | undefined;
  stateRef: React.MutableRefObject<QuestionState>;
  trySubmit: () => void;
  setTabIndex: React.Dispatch<React.SetStateAction<number>>;
  setFocusIdx: React.Dispatch<React.SetStateAction<number[]>>;
  setSelections: React.Dispatch<React.SetStateAction<string[][]>>;
}

function useQuestionKeyLayer(d: QuestionKeyLayerDeps) {
  const { keyDispatcher, stateRef, trySubmit, setTabIndex, setFocusIdx, setSelections } = d;

  useEffect(() => {
    if (!keyDispatcher) return;
    const handler = (keyEvent: { escape?: boolean; leftArrow?: boolean; rightArrow?: boolean; upArrow?: boolean; downArrow?: boolean; return?: boolean; key?: string }) => {
      const s = stateRef.current;
      const { qCount: n, reviewTabIndex: review, questions: qs } = s;
      const { tabIndex: tab, focusIdx: focus } = s;

      const onQuestionTab = tab < n;
      const isReview = review >= 0 && tab === review;

      if (keyEvent.escape) { trySubmit(); return true; }

      if (keyEvent.leftArrow && n >= 2) {
        setTabIndex((t) => (t === 0 ? review! : t - 1));
        return true;
      }
      if (keyEvent.rightArrow && n >= 2) {
        setTabIndex((t) => (t === review! ? 0 : t + 1));
        return true;
      }

      if (keyEvent.upArrow && onQuestionTab) {
        const qi = tab;
        const q = qs[qi]!;
        const cur = focus[qi]!;
        const ni = cur > 0 ? cur - 1 : q.options.length - 1;
        setFocusIdx((prev) => {
          const next = [...prev];
          next[qi] = ni;
          return next;
        });
        if (!q.multi_select) {
          const label = q.options[ni]!.label;
          setSelections((se) => se.map((row, i) => (i === qi ? [label] : [...row])));
        }
        return true;
      }

      if (keyEvent.downArrow && onQuestionTab) {
        const qi = tab;
        const q = qs[qi]!;
        const cur = focus[qi]!;
        const ni = cur < q.options.length - 1 ? cur + 1 : 0;
        setFocusIdx((prev) => {
          const next = [...prev];
          next[qi] = ni;
          return next;
        });
        if (!q.multi_select) {
          const label = q.options[ni]!.label;
          setSelections((se) => se.map((row, i) => (i === qi ? [label] : [...row])));
        }
        return true;
      }

      if (keyEvent.return) {
        if (n === 1) { trySubmit(); return true; }
        if (isReview) { trySubmit(); return true; }
        if (tab < n - 1) {
          setTabIndex(tab + 1);
        } else {
          setTabIndex(review!);
        }
        return true;
      }

      if (keyEvent.key === ' ' && onQuestionTab) {
        const qi = tab;
        const q = qs[qi]!;
        if (!q.multi_select) return false;
        const fi = focus[qi]!;
        const label = q.options[fi]!.label;
        setSelections((se) => {
          const copy = se.map((row) => [...row]);
          const row = copy[qi]!;
          const j = row.indexOf(label);
          if (j >= 0) { row.splice(j, 1); } else { row.push(label); }
          return copy;
        });
        return true;
      }

      return false;
    };
    keyDispatcher.push({ id: 'ask-user-question', handler });
    return () => void keyDispatcher.pop('ask-user-question');
  }, [keyDispatcher, trySubmit, setTabIndex, setFocusIdx, setSelections, stateRef]);
}

// ── Component ───────────────────────────────────────────────────────────────

interface OverlayAskUserQuestionProps {
  request: AskUserQuestionRequest;
  respond: (answer: AskUserQuestionResult) => void;
  dismiss: () => void;
  keyDispatcher?: KeyDispatcher;
}

function OverlayAskUserQuestion({ request, respond, dismiss, keyDispatcher }: OverlayAskUserQuestionProps) {
  const questions = request.questions;
  const qCount = questions.length;
  const reviewTabIndex = qCount >= 2 ? qCount : -1;

  const [tabIndex, setTabIndex] = useState(0);
  const [selections, setSelections] = useState<string[][]>(() => buildInitialSelections(questions));
  const [focusIdx, setFocusIdx] = useState<number[]>(() => buildInitialFocus(questions));

  const submittedRef = useRef(false);

  const stateRef = useRef<QuestionState>({ tabIndex, selections, focusIdx, questions, qCount, reviewTabIndex, respond });
  stateRef.current = { tabIndex, selections, focusIdx, questions, qCount, reviewTabIndex, respond };

  const trySubmit = useCallback(() => {
    const { selections: sel, questions: qs, respond: submit } = stateRef.current;
    if (!canSubmit(qs, sel)) return;
    submittedRef.current = true;
    submit({
      answers: qs.map((_, i) => ({
        question_index: i,
        selected_labels: [...sel[i]!],
      })),
    });
  }, [stateRef]);

  // Call dismiss on unmount if not already submitted (OverlayDescriptor contract)
  useEffect(() => {
    return () => {
      if (!submittedRef.current) { dismiss(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useQuestionKeyLayer({ keyDispatcher, stateRef, trySubmit, setTabIndex, setFocusIdx, setSelections });

  const tabRow = useMemo(() => {
    if (qCount < 2) return null;
    return (
      <Box flexDirection="row" columnGap={2} marginBottom={1} flexWrap="wrap">
        {questions.map((q, i) => (
          <Text key={i} color={tabIndex === i ? "cyan" : "gray"} bold={tabIndex === i}>
            {tabIndex === i ? "\u25b8 " : "  "}
            {tabLabel(q.header)}
          </Text>
        ))}
        <Text
          key="review"
          color={tabIndex === reviewTabIndex ? "cyan" : "gray"}
          bold={tabIndex === reviewTabIndex}
        >
          {tabIndex === reviewTabIndex ? "\u25b8 " : "  "}
          Confirm
        </Text>
      </Box>
    );
  }, [qCount, questions, tabIndex, reviewTabIndex]);

  const hint =
    qCount >= 2
      ? "\u2190/\u2192 tab \u00b7 \u2191/\u2193 option \u00b7 Space multi-toggle \u00b7 Enter next \u00b7 Esc submit"
      : "\u2191/\u2193 option \u00b7 Space multi-toggle \u00b7 Enter confirm \u00b7 Esc submit";

  const showReview = qCount >= 2 && tabIndex === reviewTabIndex;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
      {tabRow}
      <Box marginTop={1} flexDirection="column">
        {showReview ? (
          <ReviewPanel questions={questions} selections={selections} />
        ) : (
          <QuestionPanel
            question={questions[tabIndex]!}
            focusIdx={focusIdx[tabIndex]!}
            selections={selections[tabIndex]!}
          />
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  );
}

function ReviewPanel({ questions, selections }: { questions: AskUserQuestionItem[]; selections: string[][] }) {
  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold>Review choices</Text>
      {questions.map((q, i) => (
        <Box key={i} flexDirection="column">
          <Text color="cyan">{q.header}</Text>
          <Text dimColor>{selections[i]!.length ? selections[i]!.join(", ") : "(none selected)"}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>Press Enter to submit.</Text>
      </Box>
    </Box>
  );
}

function QuestionPanel({
  question,
  focusIdx,
  selections,
}: {
  question: AskUserQuestionItem;
  focusIdx: number;
  selections: string[];
}) {
  const focusedOption = question.options[focusIdx];
  const showPreview = !question.multi_select && focusedOption?.preview;

  return (
    <Box flexDirection="column" rowGap={0}>
      <Text bold>{question.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {question.options.map((opt, i) => {
          const focused = i === focusIdx;
          const selected = question.multi_select ? selections.includes(opt.label) : focused;
          const prefix = question.multi_select ? (selected ? "[x] " : "[ ] ") : focused ? "\u2771 " : "  ";
          return (
            <Box key={i} flexDirection="column">
              <Text {...(focused ? { color: 'cyan' } : {})}>
                {prefix}
                {opt.label}
              </Text>
              {focused ? <Text dimColor>
                  {"   "}
                  {opt.description}
                </Text> : null}
            </Box>
          );
        })}
      </Box>
      {showPreview && focusedOption?.preview ? <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
        >
          <Text>{focusedOption.preview}</Text>
        </Box> : null}
    </Box>
  );
}

export const overlayAskUserQuestion: OverlayDescriptor<AskUserQuestionRequest, AskUserQuestionResult> = {
  name: 'overlay.ask-user-question',
  Component: OverlayAskUserQuestion,
  useManager: useAskUserQuestionManager,
};
