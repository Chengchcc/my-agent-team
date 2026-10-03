/** ADR 0041: pull @mention targets out of a composed message. Matches the
 *  member's displayName (case-insensitive, up to whitespace) or its agentId;
 *  unknown names stay plain text — a mention never blocks delivery, it only
 *  directs routing. */

export interface MentionRosterEntry {
  readonly agentId: string;
  readonly displayName?: string | null;
}

export function parseMentions(text: string, roster: readonly MentionRosterEntry[]): string[] {
  const tokens = text.match(/@[\w.-]+/g) ?? [];
  const byName = new Map<string, string>();
  for (const r of roster) {
    if (r.displayName) byName.set(r.displayName.toLowerCase(), r.agentId);
    byName.set(r.agentId.toLowerCase(), r.agentId);
  }
  const hits: string[] = [];
  for (const t of tokens) {
    const id = byName.get(t.slice(1).toLowerCase());
    if (id && !hits.includes(id)) hits.push(id);
  }
  return hits;
}
