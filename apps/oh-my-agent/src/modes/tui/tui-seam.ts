import type { AskQuestionInput, AskQuestionResult } from "@chengchenccc/agent-contract";
import type { ModelRuntime } from "@chengchenccc/ai";
import type { SlashCommand } from "@chengchenccc/tui";
import type { ToolFilter } from "../../core/runtime/tool-filter.js";
import type { SessionBranchNode } from "../../core/session/session-file.js";
import type { ProjectSettings } from "../../core/settings/project-settings.js";
import type { TuiViewState } from "./view-state.js";

/** The TUI's seams.
 *
 *  These live here rather than in tui-mode.ts because every other TUI module
 *  depends on them: `TuiIo` is what the terminal driver implements and what
 *  tests fake, `TuiCommand` is the keybinding vocabulary, `TuiModeOptions` is
 *  the boot input. Defining them in the session loop forced io / commands /
 *  interactive to type-import BACK into the loop (a cycle in everything but
 *  type-erasure order). Data in, data out — no implementation. */

export interface TuiModeOptions {
  modelRuntime: ModelRuntime;
  workspaceRoot: string;
  /** Canonical `<provider>/<model>` id; undefined = first available. */
  model?: string;
  /** Resume a specific session file instead of starting fresh. */
  sessionId?: string;
  /** Prefill the editor with this text on boot (`oma "prompt"`). The user
   *  hits Enter to send it like any other input. */
  initialPrompt?: string;
  /** --tools filter (CLI): applied to the final tool table. */
  toolFilter?: ToolFilter;
  /** --permission CLI flag; undefined = .oma/settings.json decides. */
  permissionMode?: "ask" | "auto" | "deny" | "off";
  /** --read-only: run every session turn with no mutating tools. */
  readOnly?: boolean;
}

/** View/abort commands from the terminal (Esc abort, ctrl+t, ctrl+o, ctrl+p). */
export type TuiCommand = "toggleThinking" | "toggleToolDetail" | "abort" | "pickModel" | "forkTree";

export interface TuiIo {
  /** Render the current view state. */
  render(state: TuiViewState): void;
  /** Freeze/unfreeze terminal output. While frozen, io.render is a no-op and
   *  the loader/elapsed timers pause — zero terminal writes, so the user can
   *  scroll the native scrollback (even mid-stream) without being yanked
   *  back. Unfreezing repaints once with the latest state. */
  setFrozen?(next: boolean): void;
  /** Wait for the next user submit; resolves null on quit (Ctrl-D / /exit).
   *  Submits that arrive while a run is live (busy) are delivered to
   *  onLiveInput instead - waitForInput only resolves between runs. */
  waitForInput(): Promise<string | null>;
  /** Called once when a run goes live or settles, to toggle input mode. */
  setBusy?(busy: boolean): void;
  /** Subscriber for inputs submitted while a run is live (steer). */
  onLiveInput?(handler: ((text: string) => void) | null): void;
  /** Subscriber for slash commands submitted while a run is live; the
   *  session loop executes them instead of steering the text (pi's
   *  LiveCommandController). */
  onLiveCommand?(handler: ((text: string) => void) | null): void;
  /** Subscriber for view/abort commands (Esc, ctrl+t, ctrl+o). */
  onCommand?(handler: ((cmd: TuiCommand) => void) | null): void;
  /** Register the slash-command list for editor autocomplete. */
  setSlashCommands?(commands: readonly SlashCommand[]): void;
  /** Interactive session picker overlay; resolves the chosen session id,
   *  or null when cancelled. Absent = caller falls back to a text list. */
  pickSession?(
    sessions: ReadonlyArray<{
      id: string;
      title?: string;
      preview: string;
      modifiedAt: number;
      workspace?: string;
      forkOf?: string;
    }>,
  ): Promise<string | null>;
  /** Interactive model picker overlay (ctrl+p); resolves the chosen
   *  canonical `<provider>/<model>` id, or null when cancelled. */
  pickModel?(
    models: ReadonlyArray<{ id: string; label: string; description?: string }>,
  ): Promise<string | null>;
  /** Interactive approval confirm (HITL); resolves "allow"/"deny", null on
   *  cancel (treated as deny — fail-closed). Absent = deny. */
  confirmApproval?(req: { toolName: string; reason?: string }): Promise<"allow" | "deny" | null>;
  /** Interactive ask_question form (HITL); resolves answers or null on
   *  cancel/unsupported question kind (fail-closed). */
  askQuestions?(input: AskQuestionInput): Promise<AskQuestionResult | null>;
  /** Interactive fork-point picker (pi's user-message selector): lists the
   *  session's user messages; resolves the chosen 1-based ordinal, or null
   *  when cancelled. Absent = caller falls back to /fork <n>. */
  pickForkPoint?(points: ReadonlyArray<{ ordinal: number; text: string }>): Promise<number | null>;
  /** Interactive branch-tree fork picker: lists the session's parentId-
   *  chained message nodes; resolves the chosen node id, or null when
   *  cancelled. Absent = caller falls back to the /fork text path. */
  pickBranchTree?(nodes: ReadonlyArray<SessionBranchNode>): Promise<string | null>;
  /** Interactive settings editor; resolves the updated settings or null on
   *  cancel. Absent = caller falls back to text status. */
  editSettings?(settings: ProjectSettings): Promise<ProjectSettings | null>;
  /** Update the fixed header's model/session line. `context` is sticky:
   *  once set it stays until the next value arrives. */
  setHeader?(info: { model?: string; sessionId?: string; title?: string; context?: string }): void;
  /** M-bash: interactive pty console overlay (TUI only). Resolves when
   *  the command exits or the user kills it (Esc). */
  runPtyConsole?(
    command: string,
    cwd: string,
    env: Record<string, string>,
  ): Promise<{ exitCode: number | null; tail: string; killed: boolean }>;
  /** Prefill the editor text (used for `oma "<prompt>"`). */
  setInputText?(text: string): void;
  /** True while the terminal window holds focus (CSI 1004 reporting).
   *  Absent = always considered focused. */
  isFocused?(): boolean;
  /** Subscriber for terminal focus transitions (CSI 1004 reporting). */
  onFocus?(handler: ((focused: boolean) => void) | null): void;
  /** Best-effort completion ping (BEL). Absent = silent. */
  notify?(): void;
  /** Stop the terminal (restore modes). */
  close(): void;
}
