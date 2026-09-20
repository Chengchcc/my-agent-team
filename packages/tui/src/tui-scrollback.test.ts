import { describe, expect, test } from "bun:test";
import { Text } from "./components/text.ts";
import { TUI } from "./tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("TUI resize scrollback", () => {
  test("width change clears native scrollback so old-width wraps do not remain", async () => {
    const vt = new VirtualTerminal(20, 5);
    const tui = new TUI(vt);
    for (let i = 0; i < 10; i++) {
      tui.addChild(new Text("A".repeat(20), 0, 0));
    }
    tui.start();
    await vt.waitForRender();

    const before = vt.getScrollBuffer();
    expect(before.some((line) => line.includes("A".repeat(20)))).toBe(true);

    vt.resize(10, 5);
    await vt.waitForRender();

    const after = vt.getScrollBuffer();
    // The 20-column rows must not survive a 10-column rerender; content is
    // re-wrapped into 10-column rows instead.
    expect(after.some((line) => line.includes("A".repeat(20)))).toBe(false);
    expect(after.some((line) => line.includes("A".repeat(10)))).toBe(true);
  });
});

describe("TUI provider native scrollback", () => {
  test("history rows land in terminal scrollback and the viewport stays bounded", async () => {
    const vt = new VirtualTerminal(20, 5);
    const tui = new TUI(vt);
    let frame = 0;
    tui.setFrameProvider({
      renderFrame() {
        frame++;
        const viewport = ["V0", "V1", "V2", "V3", "V4"];
        if (frame === 1) return { viewport, history: { id: 1, rows: ["H0", "H1"] } };
        if (frame === 2) return { viewport, history: { id: 2, rows: ["H2"] } };
        return { viewport };
      },
      acknowledgeHistory() {},
    });
    tui.start();
    await vt.waitForRender();
    // Drain the provider's history batches (requestRender recurses after ack).
    await new Promise((r) => setTimeout(r, 30));
    expect(frame).toBe(3);
    const scroll = vt.getScrollBuffer();
    expect(scroll.filter((l) => l.startsWith("H"))).toEqual(["H0", "H1", "H2"]);
    expect(vt.getViewport().slice(-5)).toEqual(["V0", "V1", "V2", "V3", "V4"]);
  });

  test("requestRender(true) repaints the screen but never purges scrollback", async () => {
    const vt = new VirtualTerminal(20, 5);
    const tui = new TUI(vt);
    let frame = 0;
    tui.setFrameProvider({
      renderFrame() {
        frame++;
        const viewport =
          frame <= 2 ? ["V0", "V1", "V2", "V3", "V4"] : ["W0", "W1", "W2", "W3", "W4"];
        if (frame === 1) return { viewport, history: { id: 1, rows: ["H0", "H1"] } };
        return { viewport };
      },
      acknowledgeHistory() {},
    });
    tui.start();
    // frame 1 carries history, its ack recurses into frame 2; the frame
    // counter is the deterministic drain signal.
    while (frame < 2) await vt.waitForRender();
    expect(vt.getScrollBuffer().some((l) => l.startsWith("H0"))).toBe(true);

    // The production triggers: transcript reconcile reset (/new, resume)
    // and PTY overlay exit. Faking a width change here used to emit CSI 3 J
    // and wipe the committed history.
    tui.requestRender(true);
    while (frame < 3) await vt.waitForRender();
    expect(vt.getScrollBuffer().some((l) => l.startsWith("H0"))).toBe(true);
    expect(vt.getViewport().some((l) => l.startsWith("W0"))).toBe(true);
  });

  test("a real width change replays the committed history at the new width", async () => {
    const vt = new VirtualTerminal(20, 5);
    const tui = new TUI(vt);
    let replayed = 0;
    let frame = 0;
    let frontier = 0;
    let nextId = 1;
    let historyRows = ["H0-0123456789abcdef", "H1-0123456789abcdef"];
    tui.setFrameProvider({
      beginHistoryReplay() {
        replayed++;
        frontier = 0;
        nextId = 100;
        // Re-laid-out at the new width, like a re-wrapping transcript.
        historyRows = ["H0-0123", "H1-0123"];
      },
      renderFrame() {
        frame++;
        if (frontier < historyRows.length) {
          const rows = historyRows.slice(frontier);
          frontier += rows.length;
          return { viewport: ["V*"], history: { id: nextId++, rows } };
        }
        return { viewport: ["V*"] };
      },
      acknowledgeHistory() {},
    });
    tui.start();
    while (frame < 2) await vt.waitForRender();
    expect(vt.getScrollBuffer().some((l) => l.includes("H0-0123456789abcdef"))).toBe(true);

    vt.resize(10, 5);
    // Replay frame re-offers the whole prefix (frame 3) and its ack recurses
    // once more (frame 4) before the stream settles.
    while (frame < 4) await vt.waitForRender();

    // The purge happened (old-width rows gone) but the provider replayed
    // its committed prefix, so the history survives re-wrapped.
    expect(replayed).toBe(1);
    const scroll = vt.getScrollBuffer().join("\n");
    expect(scroll).not.toContain("H0-0123456789abcdef");
    expect(scroll).toContain("H0-0123");
  });
});

describe("adaptive render backpressure (omp #4145 port)", () => {
  test("a slow frame pushes the next ordinary paint out proportionally", async () => {
    const vt = new VirtualTerminal(40, 8);
    const tui = new TUI(vt);
    let frames = 0;
    tui.setFrameProvider({
      renderFrame({ rows }: { rows: number }) {
        frames++;
        // EVERY frame is expensive — the long-markdown-tail regime the
        // backpressure exists for (~80ms of work per paint).
        const end = performance.now() + 80;
        while (performance.now() < end) {
          /* spin */
        }
        return { viewport: Array.from({ length: rows }, (_, i) => `row ${i} #${frames}`) };
      },
      acknowledgeHistory: () => {},
    });
    tui.requestRender();
    await new Promise((r) => setTimeout(r, 200));
    const afterFirst = frames;
    // Hammer ordinary requests for 300ms: with adaptive backpressure the
    // first (120ms) frame forces the following paint to wait ~240ms, so
    // only a couple more frames land instead of one per request.
    const until = Date.now() + 300;
    while (Date.now() < until) {
      tui.requestRender();
      await new Promise((r) => setTimeout(r, 5));
    }
    const total = frames - afterFirst;
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    // Adaptive floor = 2 × 80ms = 160ms per frame; 300ms of hammering must
    // yield a handful of frames, not one per request (~60 without it).
    expect(total).toBeLessThanOrEqual(4);
  }, 20_000);
});
