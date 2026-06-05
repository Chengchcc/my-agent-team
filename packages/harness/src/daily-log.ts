/** Format a Date as YYYY-MM-DD local-date string. */
export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today's date string and yesterday's, computed from current time. */
export function todayAndYesterday(): { today: string; yesterday: string } {
  const now = new Date();
  const today = isoDate(now);
  const yesterday = isoDate(new Date(now.getTime() - 86_400_000));
  return { today, yesterday };
}
