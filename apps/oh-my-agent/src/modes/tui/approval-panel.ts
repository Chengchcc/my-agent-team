import {
  type Component,
  type Focusable,
  getKeybindings,
  matchesKey,
  renderOutputBlock,
  truncateToWidth,
  tuiTheme,
} from "@chengchenccc/tui";
import { prettyJson, styleBashLine, summarizeToolArgs } from "./tui-format.js";
import type { ApprovalPromptRequest, ApprovalVerdict } from "./tui-seam.js";

/** Docked HITL approval surface (`permissionMode="ask"` / classifier escalation).
 *  Replaces the editor at the bottom of the screen like AskPanel instead of
 *  floating a bare 2-row overlay that hides the command/arguments being approved. */

export interface ApprovalPanelOptions {
  onSettle(verdict: ApprovalVerdict | null): void;
  requestRender(): void;
}

interface ActionOption {
  readonly verdict: ApprovalVerdict;
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

const ALL_ACTIONS: readonly ActionOption[] = [
  { verdict: "allow", key: "y", label: "Allow once", color: tuiTheme.success },
  { verdict: "allow_always", key: "a", label: "Allow always", color: tuiTheme.info },
  { verdict: "deny", key: "n", label: "Deny", color: tuiTheme.error },
  { verdict: "deny_always", key: "d", label: "Deny always", color: tuiTheme.warning },
];

const SIMPLE_ACTIONS: readonly ActionOption[] = [
  { verdict: "allow", key: "y", label: "Allow", color: tuiTheme.success },
  { verdict: "deny", key: "n", label: "Deny", color: tuiTheme.error },
];

function previewInputLines(
  toolName: string,
  input: unknown,
  contentWidth: number,
  maxLines: number,
): string[] {
  if (input === undefined || input === null) return [];
  const inner = Math.max(12, contentWidth - 4);
  if (typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (toolName === "bash" && typeof record.command === "string") {
      const cmdLines = record.command.split("\n");
      const out: string[] = [];
      for (let i = 0; i < Math.min(cmdLines.length, maxLines); i++) {
        const prefix = i === 0 ? `${tuiTheme.dim}$ \u001b[0m` : "  ";
        out.push(`  ${prefix}${styleBashLine(truncateToWidth(cmdLines[i] ?? "", inner - 2))}`);
      }
      if (cmdLines.length > maxLines) {
        out.push(`  ${tuiTheme.dim}… (+${cmdLines.length - maxLines} more lines)\u001b[0m`);
      }
      return out;
    }
    const summary = summarizeToolArgs(toolName, record);
    if (toolName === "edit" && typeof record.path === "string") {
      const out = [`  ${tuiTheme.info}${truncateToWidth(record.path, inner)}\u001b[0m`];
      const oldStr = typeof record.old_string === "string" ? record.old_string.split("\n") : [];
      const newStr = typeof record.new_string === "string" ? record.new_string.split("\n") : [];
      const budget = Math.max(1, Math.floor((maxLines - 1) / 2));
      for (const l of oldStr.slice(0, budget)) {
        out.push(`  ${tuiTheme.error}- ${truncateToWidth(l, inner - 2)}\u001b[0m`);
      }
      for (const l of newStr.slice(0, budget)) {
        out.push(`  ${tuiTheme.success}+ ${truncateToWidth(l, inner - 2)}\u001b[0m`);
      }
      return out;
    }
    if (summary && !summary.startsWith("{")) {
      return [`  ${tuiTheme.info}${truncateToWidth(summary, inner)}\u001b[0m`];
    }
    const jsonLines = prettyJson(record).split("\n");
    const out = jsonLines
      .slice(0, maxLines)
      .map((l) => `  ${tuiTheme.dim}${truncateToWidth(l, inner)}\u001b[0m`);
    if (jsonLines.length > maxLines) {
      out.push(`  ${tuiTheme.dim}… (+${jsonLines.length - maxLines} more lines)\u001b[0m`);
    }
    return out;
  }
  return [`  ${tuiTheme.dim}${truncateToWidth(String(input), inner)}\u001b[0m`];
}

export class ApprovalPanel implements Component, Focusable {
  focused = false;
  private readonly actions: readonly ActionOption[];
  private selectedIndex = 0;
  private viewportRows = 24;
  private settled = false;

  constructor(
    private readonly req: ApprovalPromptRequest,
    private readonly options: ApprovalPanelOptions,
  ) {
    this.actions = req.allowAlways ? ALL_ACTIONS : SIMPLE_ACTIONS;
  }

  setViewportRows(rows: number): void {
    this.viewportRows = Math.max(1, rows);
  }

  invalidate(): void {
    // Pure render from req + selectedIndex.
  }

  dispose(): void {
    this.settled = true;
  }

  handleInput(data: string): void {
    if (this.settled) return;
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel")) {
      this.settle(null);
      return;
    }
    if (
      matchesKey(data, "left") ||
      kb.matches(data, "tui.select.up") ||
      matchesKey(data, "shift+tab")
    ) {
      this.selectedIndex = (this.selectedIndex - 1 + this.actions.length) % this.actions.length;
      this.options.requestRender();
      return;
    }
    if (
      matchesKey(data, "right") ||
      kb.matches(data, "tui.select.down") ||
      matchesKey(data, "tab")
    ) {
      this.selectedIndex = (this.selectedIndex + 1) % this.actions.length;
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      const picked = this.actions[this.selectedIndex];
      if (picked) this.settle(picked.verdict);
      return;
    }
    const lower = data.toLowerCase();
    for (const action of this.actions) {
      if (lower === action.key) {
        this.settle(action.verdict);
        return;
      }
    }
  }

  render(width: number): string[] {
    const contentWidth = Math.max(16, width - 4);
    const maxPreview = Math.max(2, Math.min(8, Math.floor(this.viewportRows * 0.35)));
    const metaParts: string[] = [];
    if (this.req.sandboxed === true) metaParts.push(`${tuiTheme.success}[sandboxed]\u001b[0m`);
    else if (this.req.sandboxed === false)
      metaParts.push(`${tuiTheme.warning}[unsandboxed]\u001b[0m`);
    if (this.req.source === "classifier") metaParts.push(`${tuiTheme.dim}classifier\u001b[0m`);

    const detailLines: string[] = [];
    if (this.req.reason) {
      detailLines.push(
        `  ${tuiTheme.warning}${truncateToWidth(this.req.reason.replace(/\r?\n/g, " "), contentWidth - 2)}\u001b[0m`,
      );
    }
    detailLines.push(
      ...previewInputLines(this.req.toolName, this.req.input, contentWidth, maxPreview),
    );
    if (detailLines.length === 0) {
      detailLines.push(`  ${tuiTheme.dim}Confirm running ${this.req.toolName}\u001b[0m`);
    }

    const actionRow = this.actions
      .map((action, idx) => {
        const keyBadge = `[${action.key}]`;
        const text = `${keyBadge} ${action.label}`;
        if (idx === this.selectedIndex) {
          return `${tuiTheme.bgOverlay}\u001b[1m${action.color} ▸ ${text} \u001b[0m`;
        }
        return `${tuiTheme.dim}   ${text} \u001b[0m`;
      })
      .join(" ");

    const hint = this.req.allowAlways
      ? "y allow · a always · n deny · d deny always · ←/→ Enter · Esc cancel"
      : "y allow · n deny · ←/→ Enter · Esc cancel";

    return renderOutputBlock({
      header: `${tuiTheme.warning}Approval · ${this.req.toolName}\u001b[0m`,
      headerMeta: metaParts.length > 0 ? metaParts.join(" ") : undefined,
      state: "running",
      borderColor: tuiTheme.warning,
      sections: [
        { lines: detailLines },
        { separator: true, lines: [` ${truncateToWidth(actionRow, contentWidth - 1)}`] },
        {
          separator: true,
          lines: [` ${tuiTheme.dim}${truncateToWidth(hint, contentWidth - 1)}\u001b[0m`],
        },
      ],
      width,
    });
  }

  private settle(verdict: ApprovalVerdict | null): void {
    if (this.settled) return;
    this.settled = true;
    this.options.onSettle(verdict);
  }
}
