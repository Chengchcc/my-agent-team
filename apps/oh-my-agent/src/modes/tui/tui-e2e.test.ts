import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualTerminal } from "@chengchenccc/tui";
import {
  fakeModelRuntime,
  quitTui,
  screen,
  typeAndSubmit,
  waitForText,
} from "./tui-e2e.fixture.js";
import { createTerminalIo, runTuiSession } from "./tui-mode.js";

describe("tui e2e: model I/O on a virtual terminal", () => {
  test("initialPrompt prefills the editor and submits on Enter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-init-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-init-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir, initialPrompt: "123" },
        io,
      );

      await vt.waitForRender();
      // The editor shows the prefilled prompt (`oma "123"` boot).
      expect(screen(vt)).toContain("123");
      // Enter sends it as a normal first turn.
      vt.sendInput("\r");
      await waitForText(vt, "done", 5_000);
      expect(screen(vt)).toContain("123");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("user input echoes, assistant answer renders, session persists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      // Drive the session in the background; input comes from the vt.
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      // 1. Typed characters appear in the editor (input echo).
      vt.sendInput("what is 2+2");
      await vt.waitForRender();
      expect(screen(vt)).toContain("what is 2+2");

      // 2. Submit (Enter) -> run starts -> assistant text renders.
      await typeAndSubmit(vt, "");
      // The fake provider answers "done"; wait for it to render.
      await vt.waitForRender();
      const rendered = screen(vt);
      // 3. The user's input is echoed in the transcript (cyan "> " prefix).
      expect(rendered).toContain("what is 2+2");
      // 4. The assistant's final answer is rendered (markdown-free text).
      expect(rendered).toContain("done");

      // 5. /exit ends the session cleanly.
      await quitTui(vt);
      expect(await sessionDone).toBe(0);

      // 6. The turn persisted to the session file: user + assistant.
      const files = readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
      const events = readFileSync(join(sessDir, files[0]!), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { type: string; message?: { role: string } });
      const messages = events.filter((e) => e.type === "message");
      expect(messages[0]?.message?.role).toBe("user");
      expect(messages.some((m) => m.message?.role === "assistant")).toBe(true);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("tool call renders its args and result on screen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-tool-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-tool-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    // Script the fake provider to emit one bash tool_use, then fall back to
    // text: the loop executes the real bash tool and streams its events.
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: "bash", input: { description: "probe", command: "echo hi" } },
    ]);
    try {
      const vt = new VirtualTerminal(100, 40);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "run a tool");
      await vt.waitForRender();
      const rendered = screen(vt);

      // Pi-style presentation: success marker + bold name + `$ cmd` summary.
      expect(rendered).toContain("bash");
      expect(rendered).toContain("$ echo hi");
      // The settled result shows the bash output, not the exit-code notice.
      expect(rendered).toContain("hi");
      expect(rendered).not.toContain("[exit: 0]");
      expect(rendered).toContain("✔");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("failing tool renders the error marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-toolerr-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-toolerr-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: "bash", input: { command: "sh -c 'exit 3'" } },
    ]);
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "fail a tool");
      await vt.waitForRender();
      const rendered = screen(vt);
      // Error marker (pi's toolErrorBg equivalent) + the failing command.
      expect(rendered).toContain("✘");
      expect(rendered).toContain("$ sh -c 'exit 3'");
      expect(rendered).toContain("[exit: 3]");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("second turn sees the first turn's transcript (session continuity)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e2-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e2-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      const vt = new VirtualTerminal(100, 40);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "first question");
      await vt.waitForRender();
      expect(screen(vt)).toContain("done");
      await typeAndSubmit(vt, "second question");
      await vt.waitForRender();
      await quitTui(vt);
      expect(await sessionDone).toBe(0);

      // Both turns are on screen (scrollback viewport is 40 rows).
      const final = screen(vt);
      expect(final).toContain("first question");
      expect(final).toContain("second question");

      // One session file, two user messages, at least two assistant messages.
      const files = readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"));
      const messages = readFileSync(join(sessDir, files[0]!), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { type: string; message?: { role: string } })
        .filter((e) => e.type === "message");
      expect(messages.filter((m) => m.message?.role === "user")).toHaveLength(2);
      expect(messages.filter((m) => m.message?.role === "assistant").length).toBeGreaterThanOrEqual(
        2,
      );
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("spinner shows while running and esc aborts the live run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-abort-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-abort-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    // A slow bash tool keeps the run live long enough to observe the
    // spinner and interrupt it mid-flight.
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: "bash", input: { description: "slow", command: "sleep 2" } },
    ]);
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "do something slow");
      await waitForText(vt, /bash · slow/, 3_000);
      const mid = screen(vt);
      expect(mid).toContain("esc to abort");
      // Esc (raw \x1b) aborts the live Run instead of the editor.
      vt.sendInput("\x1b");
      await vt.waitForRender();
      expect(screen(vt)).toContain("aborted");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("ctrl+t expands the collapsed thinking block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-think-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-think-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    process.env.OMA_FAKE_THINKING = "first reasoning line\nsecond reasoning line";
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "think about it");
      await vt.waitForRender();
      // Collapsed: only the first reasoning line is visible, with a hint.
      const collapsed = screen(vt);
      expect(collapsed).toContain("first reasoning line");
      expect(collapsed).toContain("ctrl+t");
      expect(collapsed).not.toContain("second reasoning line");

      // ctrl+t (raw \x14) toggles the full thinking block on.
      vt.sendInput("\x14");
      await vt.waitForRender();
      expect(screen(vt)).toContain("second reasoning line");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_THINKING;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("ctrl+o expands full tool result detail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-detail-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-detail-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: "bash", input: { description: "probe", command: "seq 1 60" } },
    ]);
    try {
      // Tall viewport: expanded pretty JSON plus the token status line must
      // fit without scrolling the top of the output off screen.
      const vt = new VirtualTerminal(100, 45);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "run a tool");
      // Collapsed: header + args + one-line summary with the truncation hint
      // (seq 1 60 output far exceeds the one-line cap).
      await waitForText(vt, "seq 1 60", 5000);
      await waitForText(vt, "ctrl+o", 5000);

      // ctrl+o (raw \x0f) toggles full pretty-JSON detail on.
      vt.sendInput("\x0f");
      await waitForText(vt, "command", 5000);
      await waitForText(vt, "description", 5000);

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("typing / offers the slash-command menu; /help lists commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-slash-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-slash-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      const vt = new VirtualTerminal(100, 45);
      const io = createTerminalIo(vt, dir);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      // Typing "/" pops the command menu; "he" filters it to /help.
      vt.sendInput("/");
      await vt.waitForRender();
      const menu = screen(vt);
      expect(menu).toContain("help");
      expect(menu).toContain("exit");

      vt.sendInput("help");
      await vt.waitForRender();
      vt.sendInput("\r");
      await vt.waitForRender();
      // /help echoes the command table into the transcript (grouped).
      const rendered = screen(vt);
      // The listing is longer than the viewport now: assert on the tail
      // groups (workflow is last) that always fit the sliced window.
      expect(rendered).toContain("[workflow]");
      expect(rendered).toContain("/workflow <path|script>");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("/resume opens an interactive overlay: esc cancels, enter resumes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-resume-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-resume-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    const seed = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(
      join(sessDir, `${seed}.jsonl`),
      [
        JSON.stringify({
          type: "message",
          id: "m1",
          message: { role: "user", text: "hello resume" },
        }),
      ].join("\n"),
    );
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt, dir);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      // /resume opens the picker overlay with the seeded session visible.
      await typeAndSubmit(vt, "/resume");
      await vt.waitForRender();
      const overlay = screen(vt);
      expect(overlay).toContain("resume session");
      expect(overlay).toContain("hello resume");

      // Esc cancels: overlay closes, transcript notes the cancel.
      vt.sendInput("\x1b");
      await vt.waitForRender();
      expect(screen(vt)).toContain("resume cancelled");
      expect(screen(vt)).not.toContain("↑/↓ select");

      // Reopen and select with Enter: the session resumes.
      await typeAndSubmit(vt, "/resume");
      await vt.waitForRender();
      vt.sendInput("\r");
      await vt.waitForRender();
      expect(screen(vt)).toContain(`resumed session: ${seed} (1 messages)`);
      // Resumed history is rendered in the transcript, not just a status.
      expect(screen(vt)).toContain("hello resume");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("busy Enter steers immediately with a dim » echo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-steer-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-steer-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    // A slow tool keeps the run live while the steer lands.
    process.env.OMA_FAKE_TOOL = JSON.stringify([{ name: "bash", input: { command: "sleep 1" } }]);
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "go");
      await waitForText(vt, "sleep 1", 5_000); // tool running -> live

      // Busy: type + Enter STEERS immediately (pi streamingBehavior:"steer") —
      // no queue, no empty-Enter flush gesture. The echo is a dim » item.
      vt.sendInput("continue the work");
      await vt.waitForRender();
      vt.sendInput("\r");
      await waitForText(vt, "\u00bb continue the work", 5_000);
      // The old queue panel is gone.
      expect(screen(vt)).not.toContain("follow-up");

      // The loop consumed the steer and completed the run.
      await waitForText(vt, "done", 5_000);

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("tui paint stability (differential frame writes)", () => {
  test("stable busy frames are near-silent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-paint-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-paint-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    process.env.OMA_FAKE_TEXT_LINES = Array.from(
      { length: 30 },
      (_, i) => `paint probe line ${i} of a longer answer`,
    ).join("\n");
    process.env.OMA_FAKE_TEXT_DELAY_MS = "5";
    // A slow tool then holds the run busy with a STABLE screen (loader
    // ticking, no content growth) — the window where a full-rewrite painter
    // re-erases every row (visible as flicker on terminals without DECSET
    // 2026 support) and a differential one touches only the loader rows.
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: "bash", input: { description: "hold", command: "sleep 1" } },
    ]);
    try {
      const vt = new VirtualTerminal(100, 24);
      const writes: string[] = [];
      const ESC = String.fromCharCode(27);
      const origWrite = vt.write.bind(vt);
      (vt as unknown as { write: (d: string) => void }).write = (d: string) => {
        writes.push(d);
        origWrite(d);
      };
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );
      await typeAndSubmit(vt, "stream then hold");
      await waitForText(vt, "sleep 1", 10_000);

      // Stable-screen window: no content changes, only the loader animates.
      writes.length = 0;
      await new Promise((r) => setTimeout(r, 400));
      const frames = (writes.join("").match(new RegExp(`${ESC}\\[\\?2026h`, "g")) ?? []).length;
      const perWrite = writes.map((w) => (w.match(new RegExp(`${ESC}\\[2K`, "g")) ?? []).length);
      expect(frames).toBeGreaterThanOrEqual(2);
      // Loader = a handful of rows; a full-rewrite painter emits >= 24 PER
      // FRAME. The differential painter keeps every frame tiny.
      expect(Math.max(0, ...perWrite)).toBeLessThan(12);
      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TEXT_LINES;
      delete process.env.OMA_FAKE_TEXT_DELAY_MS;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("long markdown keeps up with the model stream (no backlog dump)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-cadence-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-cadence-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    process.env.OMA_TITLE_ENABLED = "0";
    process.env.OMA_MEMORY_EXTRACT = "0";
    // ~120 deltas of realistic markdown (paragraphs + lists + a code fence),
    // 5ms apart: ~600ms of model stream. A painter that keeps up shows the
    // tail within a few hundred ms of the last delta; a backlog dump shows
    // the screen frozen mid-document and then jumping to the end.
    const lines: string[] = [];
    for (let i = 0; i < 120; i++) {
      if (i % 12 === 0) lines.push(`## Section ${i / 12}`);
      else if (i % 5 === 0) lines.push(`- bullet item ${i} with some trailing description text`);
      else lines.push(`paragraph ${i}: the renderer walks tokens and wraps them for the terminal.`);
    }
    lines.push("```ts");
    lines.push("const answer = 42;");
    lines.push("```");
    lines.push("FINAL_MARKER_LINE");
    process.env.OMA_FAKE_TEXT_LINES = lines.join("\n");
    process.env.OMA_FAKE_TEXT_DELAY_MS = "5";
    try {
      const vt = new VirtualTerminal(100, 24);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );
      const started = Date.now();
      await typeAndSubmit(vt, "long answer please");
      // Poll for the final marker; record when it shows.
      let markerAt = -1;
      const deadline = started + 20_000;
      while (Date.now() < deadline) {
        if (screen(vt).includes("FINAL_MARKER_LINE")) {
          markerAt = Date.now() - started;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      // Model stream itself: last delta lands ~600ms after submit (+ spawn).
      // Allow slack for startup; the failure mode is SECONDS of lag.
      expect(markerAt).toBeGreaterThan(0);
      expect(markerAt).toBeLessThan(3500);
      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TEXT_LINES;
      delete process.env.OMA_FAKE_TEXT_DELAY_MS;
      delete process.env.OMA_TITLE_ENABLED;
      delete process.env.OMA_MEMORY_EXTRACT;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 40_000);
});

describe("loader content policy (omp parity)", () => {
  test("the loader never mirrors streaming thinking/assistant text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-loader-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-loader-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    // Collapsed thinking renders its FIRST line in the transcript; the old
    // loader mirrored that same first line — the reported duplication.
    // 20 thinking deltas at 30ms hold the run busy ~600ms with the loader up.
    process.env.OMA_FAKE_THINKING_LINES = [
      "distinctive thinking first line marker",
      ...Array.from({ length: 19 }, (_, i) => `thinking continuation ${i}`),
    ].join("\n");
    process.env.OMA_FAKE_THINKING_DELAY_MS = "30";
    try {
      const vt = new VirtualTerminal(100, 24);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );
      await typeAndSubmit(vt, "go");
      // While busy: the collapsed thinking row shows the first line; the
      // loader row must be status-only, never an echo of that line.
      let loaderRow: string | undefined;
      let sawMarker = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const scr = screen(vt);
        if (scr.includes("distinctive thinking first line marker")) sawMarker = true;
        loaderRow = scr.split("\n").find((l) => l.includes("esc to abort"));
        if (sawMarker && loaderRow) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(sawMarker).toBe(true);
      expect(loaderRow).toBeDefined();
      expect(loaderRow).not.toContain("distinctive");
      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_THINKING_LINES;
      delete process.env.OMA_FAKE_THINKING_DELAY_MS;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("transcript viewer (/transcript)", () => {
  test("opens full-screen over the stream, scrolls, closes with q", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-view-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-view-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    process.env.OMA_FAKE_TEXT_LINES = Array.from(
      { length: 40 },
      (_, i) => `viewer content line ${i}`,
    ).join("\n");
    process.env.OMA_FAKE_TEXT_DELAY_MS = "5";
    try {
      const vt = new VirtualTerminal(100, 24);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );
      await typeAndSubmit(vt, "long answer");
      await waitForText(vt, "viewer content line 39", 10_000);

      await typeAndSubmit(vt, "/transcript");
      await waitForText(vt, "transcript viewer", 5000);
      let scr = screen(vt);
      expect(scr).toContain("transcript viewer");
      vt.sendInput("\x1b[A"); // up
      vt.sendInput("\x1b[A"); // up
      await vt.waitForRender();
      scr = screen(vt);
      expect(scr).toContain("lines "); // still in viewer
      // Page up jumps a big chunk.
      vt.sendInput("\x1b[5~");
      await vt.waitForRender();
      expect(screen(vt)).toContain("viewer content line 0"); // reached the top
      // Close.
      vt.sendInput("q");
      await vt.waitForRender();
      expect(screen(vt)).not.toContain("transcript viewer");
      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TEXT_LINES;
      delete process.env.OMA_FAKE_TEXT_DELAY_MS;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
});
