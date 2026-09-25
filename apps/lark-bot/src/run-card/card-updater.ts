import type { Database } from "bun:sqlite";
import { updateRunCard } from "../bindings-sqlite.js";
import { type CardFlushController, createCardFlushController } from "./card-flush.js";
import type { CardKitClient } from "./card-kit.js";
import {
  ACTIVITY_ELEMENT_ID,
  cardStatusKey,
  OUTPUT_ELEMENT_ID,
  type RunCardMeta,
  renderActivityContent,
  renderCard,
  renderOutputContent,
  renderStatusContent,
  renderTodoPanel,
  renderToolsContent,
  STATUS_ELEMENT_ID,
  TOOLS_ELEMENT_ID,
} from "./card-renderer.js";
import type { RunCardState } from "./card-state.js";

/** Frames that hand the card to a human. CardKit streaming mode must be off
 *  before one is shown, and it cannot be resumed on the same card — from then
 *  on every update is a full replace. */
const INTERACTIVE_FRAMES = new Set([
  "ask",
  "approval",
  "waiting_ask",
  "waiting_input",
  "waiting_approval",
]);

/** A container (the todo panel) cannot be patched as an element content, so
 *  its changes ride the full-replace path — throttled so a burst of todo_write
 *  calls cannot flood CardKit. */
const TODO_REPLACE_MIN_MS = 800;

export interface CardUpdater extends CardFlushController {
  /** Full replace with retries (terminal seal / card creation paths). */
  replaceNow(state: RunCardState): Promise<boolean>;
  /** Forget cached element contents after an external replace. */
  invalidate(state: RunCardState): void;
}

/** Owns how the card is painted: which elements stream, when the card is
 *  replaced wholesale, and the cached copies that keep a quiet run from
 *  re-PATCHing unchanged content. The watcher owns lifecycle only. */
export function createCardUpdater(deps: {
  cardClient: CardKitClient;
  db: Database;
  runId: string;
  meta: RunCardMeta;
  getState: () => RunCardState;
  getCardId: () => string | null;
  nextSeq: () => number;
  onPersist: () => void;
  /** Whether this row is already known degraded (restart resumes the state
   *  instead of hammering CardKit again). */
  degradedAtStart?: boolean;
  /** Base delay between replace retries (500ms doubling). Calibration knob:
   *  a test drives the degrade path without waiting seconds for it. */
  retryBackoffMs?: number;
}): CardUpdater {
  const { cardClient, db, runId, meta } = deps;
  const retryBackoffMs = deps.retryBackoffMs ?? 500;

  /** Element contents already pushed — only changed elements get a call. */
  let pushedOutput = "";
  let pushedActivity = "";
  let pushedTools = "";
  let pushedStatus = "";
  let pushedTodo = "null";
  let lastTodoReplaceAt = 0;
  let streamingClosed = false;
  let degraded = deps.degradedAtStart ?? false;
  /** Consecutive CardKit failures. Live painting gives up after three: the
   *  run is unaffected and the terminal text fallback still delivers, so a
   *  card that keeps failing must stop burning calls (plan §degraded). */
  let consecutiveFailures = 0;
  /** An interactive frame already attempted while degraded. A question the
   *  human must answer is the one frame worth a fresh attempt after the card
   *  gave up: without it a degraded card leaves the run unanswerable from
   *  Lark (observed live 2026-09-25). Keyed by the question's callId, so the
   *  same question is attempted once and a later one still gets its chance. */
  let attemptedWhileDegraded: string | null = null;
  /** Header frame at the last full replace — element streams cannot change
   *  the header, so a key change forces one full-card replace. */
  let pushedCardKey: string | null = null;

  const fail = (error: string): void => {
    consecutiveFailures += 1;
    const isDegraded = consecutiveFailures >= 3;
    if (isDegraded && !degraded) degraded = true;
    updateRunCard(db, runId, {
      cardUpdateFailed: 1,
      lastError: error,
      degraded: isDegraded ? true : undefined,
    });
  };

  /** After a full replace, every element is current by definition. */
  const cacheElements = (state: RunCardState): void => {
    pushedOutput = renderOutputContent(state);
    pushedActivity = renderActivityContent(state);
    pushedTools = renderToolsContent(state);
    pushedStatus = renderStatusContent(state, meta);
    pushedTodo = JSON.stringify(renderTodoPanel(state));
    pushedCardKey = cardStatusKey(state);
    lastTodoReplaceAt = Date.now();
  };

  const replaceNow = async (state: RunCardState): Promise<boolean> => {
    // Degraded means "stop painting": the seal then falls through to the
    // reliable text delivery the conversation watcher owns. The exception
    // is a question frame the human must answer - one attempt, once.
    if (degraded) {
      const frameKey = cardStatusKey(state);
      // Keyed by the question: two questions in one run share the
      // "waiting_input" frame and each deserves its own attempt.
      const askKey = state.pendingAction?.callId ?? frameKey;
      const worthRetry = INTERACTIVE_FRAMES.has(frameKey) && attemptedWhileDegraded !== askKey;
      if (!worthRetry) return false;
      attemptedWhileDegraded = askKey;
      consecutiveFailures = 0;
    }
    const cardId = deps.getCardId();
    if (!cardId) return false;
    let lastError = "card replace failed";
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await cardClient.updateCard(cardId, renderCard(state, meta), deps.nextSeq());
      if (r.ok) {
        consecutiveFailures = 0;
        cacheElements(state);
        if (degraded) {
          // The card demonstrably works again: resume painting, and let
          // future failures re-trip the threshold.
          degraded = false;
          attemptedWhileDegraded = null;
          updateRunCard(db, runId, { degraded: false });
        }
        return true;
      }
      lastError = r.error;
      await new Promise((r2) => setTimeout(r2, retryBackoffMs * 2 ** attempt));
    }
    // Exhausted retries: this counts toward the degrade threshold too, so a
    // card that cannot be sealed stops being retried forever.
    fail(lastError);
    return false;
  };

  const flushController = createCardFlushController(async () => {
    const state = deps.getState();
    const cardId = deps.getCardId();
    if (!cardId || state.terminal) return;
    if (degraded) {
      // A degraded card keeps quiet except for a question the human must
      // answer; replaceNow allows exactly one attempt per question.
      if (!state.pendingAction) return;
      const painted = await replaceNow(state);
      if (painted) deps.onPersist();
      return;
    }
    const frameKey = cardStatusKey(state);
    const frameChanged = frameKey !== pushedCardKey;
    const todoChanged = JSON.stringify(renderTodoPanel(state)) !== pushedTodo;
    const todoDue = Date.now() - lastTodoReplaceAt >= TODO_REPLACE_MIN_MS;

    if (INTERACTIVE_FRAMES.has(frameKey) && !streamingClosed) {
      // An interactive card must not sit in the streaming view (plan §ask).
      const closed = await cardClient.closeStreaming(cardId, deps.nextSeq());
      if (!closed.ok) fail(`closeStreaming: ${closed.error}`);
      else consecutiveFailures = 0;
      streamingClosed = true;
      updateRunCard(db, runId, { streamingEnabled: false });
    }

    if (frameChanged || streamingClosed || (todoChanged && todoDue)) {
      const painted = await replaceNow(state);
      if (painted) deps.onPersist();
      return;
    }

    const activityContent = renderActivityContent(state);
    if (activityContent !== pushedActivity) {
      const seqNo = deps.nextSeq();
      const r = await cardClient.streamElement({
        cardId,
        elementId: ACTIVITY_ELEMENT_ID,
        content: activityContent,
        sequence: seqNo,
        uuid: `${runId}-act-${seqNo}`,
      });
      if (!r.ok) {
        fail(r.error);
        return;
      }
      pushedActivity = activityContent;
    }
    const outputContent = renderOutputContent(state);
    if (outputContent !== pushedOutput) {
      const seqNo = deps.nextSeq();
      const r = await cardClient.streamElement({
        cardId,
        elementId: OUTPUT_ELEMENT_ID,
        content: outputContent,
        sequence: seqNo,
        uuid: `${runId}-out-${seqNo}`,
      });
      if (!r.ok) {
        // Non-fatal (ADR 0031 §2): the next delta re-flushes.
        fail(r.error);
        return;
      }
      pushedOutput = outputContent;
    }
    const toolsContent = renderToolsContent(state);
    if (toolsContent !== pushedTools) {
      const seqNo = deps.nextSeq();
      const r = await cardClient.streamElement({
        cardId,
        elementId: TOOLS_ELEMENT_ID,
        content: toolsContent,
        sequence: seqNo,
        uuid: `${runId}-tl-${seqNo}`,
      });
      if (!r.ok) {
        fail(r.error);
        return;
      }
      pushedTools = toolsContent;
    }
    const statusContent = renderStatusContent(state, meta);
    if (statusContent !== pushedStatus) {
      const seqNo = deps.nextSeq();
      const r = await cardClient.streamElement({
        cardId,
        elementId: STATUS_ELEMENT_ID,
        content: statusContent,
        sequence: seqNo,
        uuid: `${runId}-st-${seqNo}`,
      });
      if (!r.ok) {
        fail(r.error);
        return;
      }
      pushedStatus = statusContent;
    }
    deps.onPersist();
  });

  return {
    request: () => flushController.request(),
    finish: () => flushController.finish(),
    invalidate: cacheElements,
    replaceNow,
  };
}
