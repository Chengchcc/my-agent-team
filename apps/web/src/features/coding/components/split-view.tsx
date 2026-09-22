"use client";

import { useRef, useState } from "react";
import type { CodingTerminalRow } from "@/lib/api";
import { TerminalPane } from "./terminal-pane";

/** Side-by-side arrangement of a worktree's terminals — the same panes as
 *  tab mode, only the layout differs (backend untouched: the registry was
 *  keyed per-terminal from day one). Each gap gets a draggable divider; a
 *  closed pane's space redistributes via the flex ratios. */
export function SplitView({
  terminals,
  onClosed,
}: {
  terminals: CodingTerminalRow[];
  onClosed: (id: string) => void;
}) {
  const [grow, setGrow] = useState<number[]>([]);
  const rowRef = useRef<HTMLDivElement>(null);
  const value = (i: number) => grow[i] ?? 1;

  function startDrag(e: React.PointerEvent<HTMLDivElement>, gapIndex: number) {
    e.preventDefault();
    const divider = e.currentTarget;
    divider.setPointerCapture(e.pointerId);
    const row = rowRef.current;
    if (!row) return;
    const panes = [...row.querySelectorAll<HTMLElement>('[data-pane="1"]')];
    const left = panes[gapIndex]?.getBoundingClientRect().width ?? 1;
    const right = panes[gapIndex + 1]?.getBoundingClientRect().width ?? 1;
    const total = left + right;
    const startX = e.clientX;
    const MIN = 80;

    const move = (ev: PointerEvent) => {
      const nextLeft = Math.min(Math.max(left + (ev.clientX - startX), MIN), total - MIN);
      const ratio = nextLeft / total;
      setGrow((prev) => {
        const arr = [...prev];
        arr[gapIndex] = ratio * 2;
        arr[gapIndex + 1] = (1 - ratio) * 2;
        return arr;
      });
    };
    const up = () => {
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
  }

  return (
    <div ref={rowRef} className="flex size-full min-h-0 ">
      {terminals.map((term, i) => (
        <div
          key={term.terminalId}
          data-pane="1"
          className="flex min-h-0 min-w-0"
          style={{ flexGrow: value(i), flexBasis: 0 }}
        >
          {i > 0 && (
            <div
              onPointerDown={(e) => startDrag(e, i - 1)}
              className="w-1 shrink-0 cursor-col-resize bg-zinc-800 hover:bg-zinc-500"
            />
          )}
          <div className="min-h-0 min-w-0 flex-1">
            <TerminalPane terminal={term} onClosed={onClosed} />
          </div>
        </div>
      ))}
    </div>
  );
}
