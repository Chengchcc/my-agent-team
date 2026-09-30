/** Which harnesses an enabled agent names but this deployment cannot start.
 *
 *  A harness is startable when the registry knows the key and its own probe
 *  succeeded — the probe opens a real session, so an error there is evidence the
 *  agent binary cannot be spawned at all. Those agents fail at dispatch, and the
 *  backend reports an unregistered key loudly rather than falling back to some
 *  other harness, so the UI says so before the user runs one. */
export function blockedHarnesses(
  agents: ReadonlyArray<{ enabled?: boolean; harness: string }>,
  harnesses: ReadonlyArray<{ key: string; error?: string | null }>,
): string[] {
  const startable = new Set(harnesses.filter((h) => !h.error).map((h) => h.key));
  const blocked = new Set<string>();
  for (const agent of agents) {
    if (agent.enabled === false) continue;
    if (startable.has(agent.harness)) continue;
    blocked.add(agent.harness);
  }
  return [...blocked].sort();
}
