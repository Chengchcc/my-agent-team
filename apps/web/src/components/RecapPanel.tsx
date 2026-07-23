"use client";

interface RecapData {
  text: string;
  turn: number;
}

export function RecapPanel({ recap }: { recap: RecapData | null }) {
  if (!recap) return null;

  return (
    <div className="shrink-0 w-[260px] border-l border-[var(--hairline)] bg-[var(--canvas-soft)] p-4 overflow-y-auto hidden xl:block">
      <div className="text-[10px] tracking-[0.1em] uppercase text-[var(--mute)] mb-2">
        Recap · Turn {recap.turn}
      </div>
      <p className="text-sm text-[var(--ink-strong)] leading-relaxed animate-fadeIn">
        {recap.text}
      </p>
    </div>
  );
}
