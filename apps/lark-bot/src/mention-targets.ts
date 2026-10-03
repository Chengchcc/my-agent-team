import { type LarkMessageEvent, MENTION_ALL_KEY } from "./event-parser.js";

/** ADR 0041: map a group message's structured mentions onto the
 *  conversation's member agent ids. Matching is by display name
 *  (case-insensitive) — the same evidence isBotMentioned uses; a name that
 *  matches no member routes to nobody. Duplicates collapse in order of
 *  appearance. */
export function resolveMentionTargets(input: {
  mentions: LarkMessageEvent["mentions"];
  /** The conversation's members WITH the bot's own agent appended by the
   *  caller — this function stays pure over what it is given. */
  roster: ReadonlyArray<{ agentId: string; name: string }>;
}): string[] {
  const byName = new Map<string, string>();
  for (const m of input.roster) {
    if (m.name) byName.set(m.name.trim().toLowerCase(), m.agentId);
  }
  const hits: string[] = [];
  for (const m of input.mentions ?? []) {
    if (m.key === MENTION_ALL_KEY) continue;
    const id = byName.get(m.name.trim().toLowerCase());
    if (id && !hits.includes(id)) hits.push(id);
  }
  return hits;
}
