/**
 * Helpers to bridge a native <input type="date"> (yyyy-mm-dd string) and the
 * epoch-millis representation used by IssueRow.estimatedCompletionAt.
 * Shared by the create-issue form (issues/page.tsx) and the edit form
 * (IssueDetailSheet.tsx) so the conversion logic lives in one place.
 *
 * Both directions operate in UTC so the round-trip is symmetric: a date the
 * user picks reads back as the same date regardless of their timezone. Using
 * local time on one side and UTC on the other shifts the date by a day for
 * any user east/west of UTC.
 */
export function epochToDateInput(ts: number | null): string {
  if (ts == null) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

export function dateInputToEpoch(value: string): number | null {
  if (!value) return null;
  // Parse as UTC midnight (note the trailing "Z") to mirror epochToDateInput,
  // which formats via toISOString() (UTC). Without the "Z", Date.parse treats
  // a bare date-time string as local time and the round-trip drifts by a day.
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}
