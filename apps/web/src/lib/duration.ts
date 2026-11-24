/** A duration as a person reads it. Raw seconds turned a 41-day zombie
 *  execution into "3,600,538s" and a healthy run into "43299s" (console review
 *  2026-11-24); "41d 6h" makes the zombie visible at a glance. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${s % 60}s`;
}

/** Milliseconds in, same words out. */
export function formatDurationMs(ms: number): string {
  return formatDuration(ms / 1000);
}
