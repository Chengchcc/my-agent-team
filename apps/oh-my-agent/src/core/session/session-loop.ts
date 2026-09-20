import type { OmaRuntime } from "../runtime/create-runtime.js";
import {
  appendSessionCompaction,
  appendSessionMessages,
  appendSessionSummary,
  appendSessionTitle,
  loadSessionMessages,
  newSessionId,
  sessionDir,
} from "./session-file.js";

/** Shared session persistence for the interactive CLI modes (TUI) and the
 *  one-shot modes (print). Mirrors the RPC mode's session semantics
 *  (ADR 0003 decision 6): the CLI owns its session file; the product
 *  stores only the session id. A completed turn (input + assistant/tool
 *  messages + compaction summaries) is appended after the run. */

/** Finalize a turn in the session file: writes compaction summaries and the
 *  auto title/summary. Conversational messages are written in REAL TIME via
 *  createOmaRuntime's onPersistMessages (pi appendMessage) when the caller
 *  wires it; `messages` is the fallback batch for one-shot modes (print)
 *  that do not use real-time persistence. */
export async function persistSessionTurn(opts: {
  sessionId: string;
  cwd: string;
  runtime: OmaRuntime;
  /** Messages not already written by the real-time hook (print mode). */
  messages?: readonly unknown[];
  /** The run's auto-generated title (outcome.title), when present. */
  title?: string;
  /** The run's one-sentence session summary (outcome.summary), when present. */
  summary?: string;
  /** Session directory; defaults to the current workspace. Cross-workspace
   *  resumes pass the source workspace's dir so new turns append there. */
  dir?: string;
}): Promise<void> {
  if (opts.messages && opts.messages.length > 0) {
    appendSessionMessages(opts.sessionId, opts.cwd, opts.messages, opts.dir);
  }
  for (const compaction of await opts.runtime.compactions()) {
    // The flag rides the event: a summary that does NOT describe the whole
    // file must not fold it, or a resume drops the messages it never saw.
    appendSessionCompaction(
      opts.sessionId,
      compaction.summary,
      opts.dir,
      compaction.replacesEarlierMessages,
    );
  }
  if (opts.title) appendSessionTitle(opts.sessionId, opts.title, opts.dir);
  if (opts.summary) appendSessionSummary(opts.sessionId, opts.summary, opts.dir);
}

/** Resolve the session for a new TUI turn: a --session id resumes that
 *  file (missing/corrupt file degrades to fresh); otherwise a new id.
 *  `dir` is the session directory the file lives in (current workspace by
 *  default; cross-workspace resumes pass their own workspace dir). */
export function resolveSession(
  sessionId?: string,
  dir?: string,
): {
  sessionId: string;
  messages: Record<string, unknown>[];
  dir: string;
} {
  const id = sessionId ?? newSessionId();
  const resolvedDir = dir ?? sessionDir();
  return { sessionId: id, messages: loadSessionMessages(id, resolvedDir), dir: resolvedDir };
}
