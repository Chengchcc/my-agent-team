import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, Container, TUI, VirtualTerminal, visibleWidth } from "@chengchenccc/tui";
import { saveInputHistory } from "../../core/session/input-history.js";
import { ApprovalPanel } from "./approval-panel.js";
import { SettingsOverlay } from "./settings-overlay.js";
import { FilterablePickerOverlay, OmaTranscriptContainer } from "./tui-components.js";
import { EDITOR_THEME } from "./tui-format.js";
import { TuiItemRenderer, TuiRenderShell } from "./tui-render.js";
import type { ApprovalVerdict } from "./tui-seam.js";
import { TuiTranscriptReconciler } from "./tui-transcript-reconciler.js";
import { initialViewState, type TranscriptItem } from "./view-state.js";

const stripAnsi = (s: string): string =>
  s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;:]*m`, "g"), "");

describe("ApprovalPanel (docked HITL)", () => {
  test("renders command, sandbox badge, reason, and supports y/a/n/d hotkeys + Esc", () => {
    const verdicts: Array<ApprovalVerdict | null> = [];
    const makePanel = (allowAlways = true) =>
      new ApprovalPanel(
        {
          toolName: "bash",
          input: { command: "rm -rf build && bun run build" },
          reason: "destructive build cleanup",
          sandboxed: true,
          source: "permission",
          allowAlways,
        },
        {
          onSettle: (v) => verdicts.push(v),
          requestRender: () => {},
        },
      );

    const p1 = makePanel(true);
    const rendered = p1.render(80).map(stripAnsi).join("\n");
    expect(rendered).toContain("Approval · bash");
    expect(rendered).toContain("[sandboxed]");
    expect(rendered).toContain("$ rm -rf build && bun run build");
    expect(rendered).toContain("destructive build cleanup");
    expect(rendered).toContain("[y] Allow once");
    expect(rendered).toContain("[a] Allow always");
    expect(rendered).toContain("[n] Deny");
    expect(rendered).toContain("[d] Deny always");

    p1.handleInput("a");
    expect(verdicts).toEqual(["allow_always"]);

    const p2 = makePanel(true);
    p2.handleInput("d");
    expect(verdicts.at(-1)).toBe("deny_always");

    const p3 = makePanel(false);
    const simpleRendered = p3.render(80).map(stripAnsi).join("\n");
    expect(simpleRendered).not.toContain("Allow always");
    p3.handleInput("\x1b[C"); // right -> Deny
    p3.handleInput("\r");
    expect(verdicts.at(-1)).toBe("deny");

    const p4 = makePanel(true);
    p4.handleInput("\x1b");
    expect(verdicts.at(-1)).toBeNull();
  });
});

describe("FilterablePickerOverlay", () => {
  test("filters live, shows custom emptyMessage, supports Ctrl+D delete and ModalFrame", () => {
    let selected: string | null = null;
    const deleted: string[] = [];
    const overlay = new FilterablePickerOverlay({
      title: "Resume Session",
      emptyMessage: "  No sessions match",
      theme: EDITOR_THEME.selectList,
      items: [
        { value: "s1", label: "01-01 10:00", description: "Fix auth token refresh" },
        { value: "s2", label: "01-02 11:00", description: "Refactor TUI layout" },
        { value: "s3", label: "01-03 12:00", description: "Add vector embeddings" },
      ],
      onSelect: (item) => {
        selected = item.value;
      },
      onCancel: () => {},
      onDelete: (item) => {
        deleted.push(item.value);
        return true;
      },
    });

    const initial = overlay.render(70).map(stripAnsi);
    expect(initial[0]?.startsWith("╭─")).toBe(true);
    expect(initial[0]).toContain("Resume Session");
    expect(initial.at(-1)?.startsWith("╰─")).toBe(true);

    // Filter down to "tui"
    overlay.handleInput("t");
    overlay.handleInput("u");
    overlay.handleInput("i");
    const filtered = overlay.render(70).map(stripAnsi).join("\n");
    expect(filtered).toContain("Refactor TUI layout");
    expect(filtered).not.toContain("Fix auth token refresh");
    expect(filtered).toContain("1/3");

    // Select filtered match
    overlay.handleInput("\r");
    expect(selected).toBe("s2");

    // Delete matched item via Ctrl+D
    overlay.handleInput("\x04");
    expect(deleted).toEqual(["s2"]);
    const afterDel = overlay.render(70).map(stripAnsi).join("\n");
    expect(afterDel).toContain("No sessions match");
  });
});

describe("SettingsOverlay cursor preservation & ModalFrame", () => {
  test("preserves selected index across boolean toggle and renders hint strip", () => {
    const overlay = new SettingsOverlay({ bashSandbox: false }, () => {});
    // Move down 6 rows to bashSandbox (index 6)
    for (let i = 0; i < 6; i++) overlay.handleInput("\x1b[B");
    const before = overlay.render(76).map(stripAnsi).join("\n");
    expect(before).toContain("Project Settings");
    expect(before).toContain("7/");
    expect(before).toContain("OS-level bash sandbox");

    // Toggle bashSandbox with Enter — cursor must stay on row 7, not jump to 1!
    overlay.handleInput("\r");
    expect(overlay.getSettings().bashSandbox).toBe(true);
    const after = overlay.render(76).map(stripAnsi).join("\n");
    expect(after).toContain("7/");
    expect(after).toContain("● on");
  });
});

describe("saveInputHistory read-only resilience", () => {
  test("returns false without throwing when OMA_CODING_AGENT_DIR is unwritable", () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-ro-hist-"));
    const blockingFile = join(dir, "not-a-dir");
    writeFileSync(blockingFile, "x", "utf8");
    const savedEnv = process.env.OMA_CODING_AGENT_DIR;
    process.env.OMA_CODING_AGENT_DIR = blockingFile;
    try {
      expect(() => saveInputHistory(["hello"])).not.toThrow();
      expect(saveInputHistory(["hello"])).toBe(false);
    } finally {
      if (savedEnv === undefined) delete process.env.OMA_CODING_AGENT_DIR;
      else process.env.OMA_CODING_AGENT_DIR = savedEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("TuiItemRenderer terminal-native formatting", () => {
  test("sanitizes CR/LF in status and error items into safe lines", () => {
    const tui = new TUI(new VirtualTerminal(80, 24));
    const renderer = new TuiItemRenderer(tui);
    const state = initialViewState();

    const statusLines = renderer
      .renderItem(
        { kind: "status", text: "line one\r\nline two\rline three", streaming: false },
        state,
      )
      .map(stripAnsi);
    expect(statusLines.length).toBe(3);
    for (const line of statusLines) expect(line).not.toContain("\r");

    const errLines = renderer
      .renderItem({ kind: "error", text: "boom\r\ndetail", streaming: false }, state)
      .map(stripAnsi);
    expect(errLines.length).toBe(2);
    expect(errLines[0]).toContain("error: boom");
    expect(errLines[1]).toContain("detail");
  });

  test("collapsed tool uses compact Gutter/Tree without Timeout clutter or empty Output", () => {
    const tui = new TUI(new VirtualTerminal(80, 24));
    const renderer = new TuiItemRenderer(tui);
    const state = initialViewState();

    const item: TranscriptItem = {
      kind: "tool",
      text: "read",
      streaming: false,
      durationMs: 12,
      input: { path: "src/app.ts", offset: 1, limit: 2 },
      result: { isError: false },
    };
    const collapsed = renderer.renderItem(item, state).map(stripAnsi);
    expect(collapsed.length).toBe(1);
    expect(collapsed[0]).toContain("✔ read");
    expect(collapsed[0]).toContain("src/app.ts:1-2");
    expect(collapsed[0]).toContain("12ms");
    expect(collapsed[0]).not.toContain("Timeout");
    expect(collapsed[0]).not.toContain("isError");

    // Edit tool renders line-numbered width-aware diff
    const editItem: TranscriptItem = {
      kind: "tool",
      text: "edit",
      streaming: false,
      durationMs: 8,
      input: {
        path: "demo.ts",
        old_string: "const oldVal = 1;",
        new_string: "const newVal = 2;",
      },
      result: { content: "ok" },
    };
    const diffRendered = renderer.renderItem(editItem, state).map(stripAnsi).join("\n");
    expect(diffRendered).toContain("1 - const oldVal = 1;");
    expect(diffRendered).toContain("1 + const newVal = 2;");

    // Expanded (Ctrl+O) renders full OutputBlock
    const expanded = renderer
      .renderItem(editItem, { ...state, showToolDetail: true })
      .map(stripAnsi);
    expect(expanded[0]?.startsWith("┌───")).toBe(true);
  });

  test("flex statusbar preserves mode, model, and ctx% at 60 cols and narrow header drops banner", () => {
    const vt = new VirtualTerminal(60, 24);
    const tui = new TUI(vt);
    const transcript = new OmaTranscriptContainer();
    const shell = new TuiRenderShell(
      tui,
      transcript,
      new Container(),
      "/workspace/my-agent-team",
      "",
    );
    shell.setDriverStatus("plan", "✎ plan");
    shell.setHeader("anthropic/sonnet", "12345678-abcd", "", "ctx 100k/200k · 50%", {
      estimatedTokens: 100_000,
      limit: 200_000,
      pct: 50,
    });

    const bar60 = stripAnsi(shell.renderStatusBarLine(60));
    expect(visibleWidth(bar60)).toBe(60);
    expect(bar60).toContain("✎ plan");
    expect(bar60).toContain("anthropic/sonnet");
    expect(bar60).toContain("50%");

    // Narrow (<72 cols) header omits wide ASCII banner so workspace line is clean
    const headerText = transcript.children
      .flatMap((c) => c.render(60))
      .map(stripAnsi)
      .join("\n");
    expect(headerText).not.toContain("██████╗");
    expect(headerText).toContain("workspace:");
    expect(headerText).toContain("anthropic/sonnet");
  });
});

describe("TUI performance invariants", () => {
  test("PERF-1: reconciler skips settled historical groups without reallocating children", () => {
    const tui = new TUI(new VirtualTerminal(80, 24));
    const transcript = new OmaTranscriptContainer();
    const renderer = new TuiItemRenderer(tui);
    const reconciler = new TuiTranscriptReconciler();
    const state = initialViewState();

    const settledUser: TranscriptItem = { kind: "user", text: "hello", streaming: false };
    const settledAssistant: TranscriptItem = {
      kind: "assistant",
      text: "world response",
      streaming: false,
    };
    const liveAssistant: TranscriptItem = {
      kind: "assistant",
      text: "stream chunk 1",
      streaming: true,
    };
    state.runs.push(
      { items: [settledUser, settledAssistant], running: false },
      { items: [liveAssistant], running: true },
    );

    reconciler.reconcile(transcript, state.runs, state, (item) => renderer.renderItem(item, state));
    const snapshotSettledFirst = transcript.children[0];
    const snapshotSettledAssistant = transcript.children[2];
    expect(snapshotSettledFirst).toBeDefined();
    expect(snapshotSettledAssistant).toBeDefined();

    // Stream 20 updates on live tail — historical children MUST stay the exact same object refs!
    for (let i = 2; i <= 21; i++) {
      liveAssistant.text += ` word${i}`;
      reconciler.reconcile(transcript, state.runs, state, (item) =>
        renderer.renderItem(item, state),
      );
    }
    expect(transcript.children[0]).toBe(snapshotSettledFirst);
    expect(transcript.children[2]).toBe(snapshotSettledAssistant);
  });

  test("PERF-4: OmaTranscriptContainer.renderViewport never renders committed history children", () => {
    const transcript = new OmaTranscriptContainer();
    let committedRenderCalls = 0;
    const makeSpyChild = (label: string, onRender: () => void): Component => ({
      invalidate() {},
      render() {
        onRender();
        return [label];
      },
    });
    for (let i = 0; i < 5; i++) {
      transcript.addChild(
        makeSpyChild(`hist-${i}`, () => {
          committedRenderCalls++;
        }),
      );
    }
    transcript.addChild(makeSpyChild("live-0", () => {}));

    // Advance frontier through normal peek/ack
    transcript.renderViewport(80, 2);
    transcript.setNativeScrollbackCommittedRows(5);
    const batch = transcript.peekFinalizedBatch(80);
    expect(batch).toBeDefined();
    transcript.acknowledgeFinalizedBatch(batch!.id);

    committedRenderCalls = 0;
    const vp = transcript.renderViewport(80, 10);
    expect(vp).toEqual(["live-0"]);
    expect(committedRenderCalls).toBe(0);
  });
});
