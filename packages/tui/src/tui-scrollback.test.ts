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
