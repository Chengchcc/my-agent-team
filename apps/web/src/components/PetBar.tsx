"use client";

import { useState } from "react";

export interface PetBarkData {
  mood: "happy" | "neutral" | "frustrated" | "excited";
  text: string;
  level: number;
  turn: number;
}

const MOOD_EMOJI: Record<string, string> = {
  happy: "😊",
  neutral: "🐾",
  frustrated: "😤",
  excited: "✨",
};

const MOOD_COLOR: Record<string, string> = {
  happy: "text-emerald-600",
  neutral: "text-[var(--mute)]",
  frustrated: "text-orange-600",
  excited: "text-blue-600",
};

const MOOD_BG: Record<string, string> = {
  happy: "bg-emerald-50",
  neutral: "bg-[var(--canvas-soft)]",
  frustrated: "bg-orange-50",
  excited: "bg-blue-50",
};

/** Parse <pet mood="..." level="...">text</pet> from a string. */
export function parsePetBark(text: string): PetBarkData | null {
  const match = text.match(/<pet\s+mood="(\w+)"\s+level="(\d+)">([\s\S]*?)<\/pet>/);
  if (!match) return null;
  return {
    mood: match[1] as PetBarkData["mood"],
    level: parseInt(match[2] ?? "1", 10),
    text: match[3]!.trim(),
    turn: 0,
  };
}

/** Pet status bar shown at bottom of ConversationCanvas, left of Composer. */
export function PetStatusBar({ bark }: { bark: PetBarkData | null }) {
  const [expanded, setExpanded] = useState(false);

  if (!bark) {
    return (
      <div className="flex items-center gap-1 px-2 py-1 text-xs text-[var(--mute)] shrink-0">
        <span>🐾</span>
      </div>
    );
  }

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs ${MOOD_COLOR[bark.mood]} ${MOOD_BG[bark.mood]} hover:opacity-80 transition-opacity`}
        title="Pet status"
      >
        <span>{MOOD_EMOJI[bark.mood]}</span>
        <span className="font-medium">Lv.{bark.level}</span>
      </button>
      {expanded && (
        <div className="absolute bottom-full left-0 mb-2 w-64 rounded-lg border border-[var(--hairline)] bg-[var(--canvas)] shadow-lg p-3 z-50">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg">{MOOD_EMOJI[bark.mood]}</span>
            <span className="text-sm font-medium">Pet · Lv.{bark.level}</span>
            <span className={`text-xs ${MOOD_COLOR[bark.mood]}`}>{bark.mood}</span>
          </div>
          <div className="text-xs text-[var(--ink-strong)] border-l-2 border-[var(--hairline)] pl-2">
            {bark.text}
          </div>
          <div className="text-[10px] text-[var(--mute)] mt-2">Turn {bark.turn}</div>
        </div>
      )}
    </div>
  );
}

/** Pet bark bubble rendered in the message timeline. */
export function PetBarkBubble({ bark }: { bark: PetBarkData }) {
  const moodColor = MOOD_COLOR[bark.mood];
  const moodBg = MOOD_BG[bark.mood];

  return (
    <div className={`rounded-lg ${moodBg} border border-[var(--hairline)] p-3 my-2 max-w-md`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-base">{MOOD_EMOJI[bark.mood]}</span>
        <span className="text-xs font-medium text-[var(--ink-strong)]">Pet</span>
        <span className="text-[10px] text-[var(--mute)]">Lv.{bark.level}</span>
        <span className={`text-[10px] ${moodColor}`}>· {bark.mood}</span>
      </div>
      <p className="text-sm text-[var(--ink-strong)]">{bark.text}</p>
    </div>
  );
}
