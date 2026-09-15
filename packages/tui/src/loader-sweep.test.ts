import { describe, expect, test, vi } from "bun:test";
import { Loader } from "./components/loader.ts";
import type { TUI } from "./tui.ts";

const ESC = String.fromCharCode(27);

/** Cell index of the bright (bold) sweep tier on the rendered line, or -1. */
function bandCell(line: string): number {
  return visibleIndex(line, `${ESC}[1m${ESC}[36m`);
}

/** The message row: Loader.render pads with a blank row above and below. */
function messageRow(loader: Loader): string {
  return loader.render(80)[1] ?? "";
}

/** Index (in visible cells) where `marker` starts in an ANSI string. */
function visibleIndex(line: string, marker: string): number {
  const at = line.indexOf(marker);
  if (at === -1) return -1;
  const before = line.slice(0, at).replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
  return [...before].length;
}

describe("Loader light sweep covers the whole line", () => {
  test("the band travels past the spinner's 10-frame window", () => {
    vi.useFakeTimers();
    try {
      const stub = { requestRender: () => {} } as unknown as TUI;
      const message = "bash · a fairly long command line that keeps working";
      const loader = new Loader(
        stub,
        (s) => s,
        (s) => s,
        message,
      );
      loader.start();
      const seen: number[] = [];
      // 40 ticks × 80ms: well past the 10-frame modulo the bug was capped at.
      for (let tick = 0; tick < 40; tick++) {
        vi.advanceTimersByTime(80);
        seen.push(bandCell(messageRow(loader)));
      }
      const lit = seen.filter((i) => i >= 0);
      expect(lit.length).toBeGreaterThan(0);
      // Pre-fix the band never left cells 0..9.
      expect(Math.max(...lit)).toBeGreaterThan(12);
    } finally {
      vi.useRealTimers();
    }
  });

  test("over one full period every cell is lit at least once", () => {
    vi.useFakeTimers();
    try {
      const stub = { requestRender: () => {} } as unknown as TUI;
      const message = "abcdefghijklmnopqrstuvwxyz0123456789"; // 36 cells
      const loader = new Loader(
        stub,
        (s) => s,
        (s) => s,
        message,
      );
      loader.start();
      const litCells = new Set<number>();
      for (let tick = 0; tick < 36 + 12 + 2; tick++) {
        vi.advanceTimersByTime(80);
        const line = messageRow(loader);
        const idx = bandCell(line);
        if (idx >= 0) litCells.add(idx);
      }
      // The band enters from the left padding and leaves on the right, so
      // the entire message gets lit over one pass.
      const covered = [...litCells].filter((i) => i < message.length);
      expect(covered.length).toBeGreaterThan(message.length - 4);
    } finally {
      vi.useRealTimers();
    }
  });
});
