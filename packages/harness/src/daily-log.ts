/** Format a Date as YYYY-MM-DD local-date string. */
export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today's date string and yesterday's, computed from a single timestamp. */
export function todayAndYesterday(): { today: string; yesterday: string } {
  const nowMs = Date.now();
  const today = isoDate(new Date(nowMs));
  const yesterday = isoDate(new Date(nowMs - 86_400_000));
  return { today, yesterday };
}
