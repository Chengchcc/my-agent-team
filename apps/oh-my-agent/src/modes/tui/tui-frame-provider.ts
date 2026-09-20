import type { Component, Container, Editor, TerminalFrameProvider } from "@chengchenccc/tui";
import type { OmaTranscriptContainer } from "./tui-components.js";
import type { TuiRenderShell } from "./tui-render.js";
import {
  renderFanoutBriefChrome,
  renderLiveAgentsChrome,
  renderTodoChrome,
} from "./tui-tool-render.js";

export interface OmaFrameProviderOptions {
  transcript: OmaTranscriptContainer;
  statusContainer: Container;
  editor: Editor;
  shell: TuiRenderShell;
  /** The bottom region: normally the editor, but a HITL panel (ask_question)
   *  DOCKED here while it is live — the input row is replaced rather than
   *  covered, so a question the model is blocked on cannot be mistaken for a
   *  transient overlay. Resolved per frame (the provider is built once). */
  bottom?: () => Component;
}

/** A bottom-region component that sizes itself to the live viewport. Chrome is
 *  allowed to change height here (the transcript window simply shrinks); a
 *  DOCKED panel needs the real row count to clamp itself to a fraction of it,
 *  and it must not read `process.stdout` — the frame provider's `rows` is the
 *  authority, which is also what the VirtualTerminal tests drive. */
interface ViewportSized {
  setViewportRows(rows: number): void;
}

function isViewportSized(component: Component): component is Component & ViewportSized {
  return typeof (component as { setViewportRows?: unknown }).setViewportRows === "function";
}

/** Composes the bounded mutable viewport (live transcript tail + status/
 *  editor). The header prints INTO the transcript once per session
 *  (cc-style) and scrolls away with content — it is not live chrome; the
 *  todo snapshot is the opposite: live chrome pinned above the status
 *  area, never scrolled away. */
export function createOmaFrameProvider({
  transcript,
  statusContainer,
  editor,
  shell,
  bottom,
}: OmaFrameProviderOptions): TerminalFrameProvider {
  return {
    renderFrame({ columns, rows }) {
      const width = columns;
      const bottomComponent = bottom?.() ?? editor;
      if (isViewportSized(bottomComponent)) bottomComponent.setViewportRows(rows);
      const todo = renderTodoChrome(shell.viewState?.todoItems ?? [], width);
      // Two pinned blocks, in reading order: WHAT the fan-out is for (brief),
      // then WHO is doing it (live rows). The brief unmounts with the panel.
      const expanded = shell.viewState?.showToolDetail === true;
      const brief = shell.viewState?.fanoutGoal
        ? renderFanoutBriefChrome(shell.viewState.fanoutGoal, width, expanded)
        : [];
      const agents = renderLiveAgentsChrome(
        [...(shell.viewState?.liveAgents.values() ?? [])],
        width,
        expanded,
      );
      const after = [
        ...todo,
        ...brief,
        ...agents,
        ...statusContainer.render(width),
        ...bottomComponent.render(width),
      ];
      const available = Math.max(0, rows - after.length);
      const target = Math.max(0, shell.lastTotalRows - available);
      const boundary = Math.min(shell.lastLiveStartRow, target);
      transcript.setNativeScrollbackCommittedRows(boundary);
      const active = available > 0 ? transcript.renderViewport(width, available) : [];
      const viewport = [...active, ...after];
      const history = transcript.renderOfferedHistory(width);
      return { viewport, history };
    },
    acknowledgeHistory(id) {
      transcript.acknowledgeFinalizedBatch(id);
    },
    beginHistoryReplay() {
      transcript.beginReplay();
    },
    beginHistoryFlush() {
      transcript.beginHistoryFlush();
    },
  };
}
