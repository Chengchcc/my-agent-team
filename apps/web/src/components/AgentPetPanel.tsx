"use client";

import { useSettings } from "@/features/settings/hooks";

function parsePetSetting(raw: Record<string, unknown>, agentId: string) {
  const prefix = `pet.${agentId}.`;
  const get = (k: string) => raw[`${prefix}${k}`];
  const level = Number(get("level") ?? 1);
  const xp = Number(get("xp") ?? 0);
  const totalTurns = Number(get("totalTurns") ?? 0);
  const totalBarks = Number(get("totalBarks") ?? 0);
  const xpNeeded = 100 * level;
  return { level, xp, xpNeeded, totalTurns, totalBarks };
}

export function AgentPetPanel({ agentId }: { agentId: string }) {
  const { data, isLoading } = useSettings();
  if (isLoading || !data) return <div className="text-sm text-[var(--mute)]">Loading...</div>;

  const s = parsePetSetting(data.settings, agentId);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <span className="text-4xl">{s.level >= 10 ? "⭐" : "🐾"}</span>
        <div>
          <h2 className="text-lg font-semibold">Pet · Lv.{s.level}</h2>
          <p className="text-sm text-[var(--mute)]">
            {s.totalTurns} turns · {s.totalBarks} barks
          </p>
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex justify-between text-xs text-[var(--mute)]">
          <span>XP</span>
          <span>
            {s.xp} / {s.xpNeeded}
          </span>
        </div>
        <div className="h-2 rounded-full bg-[var(--canvas-soft)] overflow-hidden">
          <div
            className="h-full rounded-full bg-[var(--primary)] transition-all"
            style={{ width: `${Math.min((s.xp / s.xpNeeded) * 100, 100)}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Level" value={String(s.level)} />
        <Stat label="XP" value={String(s.xp)} />
        <Stat label="Turns" value={String(s.totalTurns)} />
        <Stat label="Barks" value={String(s.totalBarks)} />
        <Stat label="Next Level" value={`${s.xpNeeded - s.xp} XP`} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--hairline)] p-3">
      <div className="text-[10px] tracking-[0.1em] uppercase text-[var(--mute)]">{label}</div>
      <div className="text-lg font-semibold mt-1">{value}</div>
    </div>
  );
}
