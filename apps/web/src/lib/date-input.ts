/**
 * Helpers to bridge a native <input type="date"> (yyyy-mm-dd string) and the
 * epoch-millis representation used by IssueRow.estimatedCompletionAt.
 * Shared by the create-issue form (issues/page.tsx) and the edit form
 * (IssueDetailSheet.tsx) so the conversion logic lives in one place.
 */
export function epochToDateInput(ts: number | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

export function dateInputToEpoch(value: string): number | null {
  if (!value) return null;
  const ms = Date.parse(`${value}T00:00:00`);
  return Number.isNaN(ms) ? null : ms;
}
