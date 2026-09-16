/** Which backend kinds a catalog can actually serve. `available` is true by
 *  construction (only registered providers appear), so an honest false is
 *  treated as unusable. */
export function usableBackends(
  catalog: ReadonlyArray<{ backendKind: string; available?: boolean }>,
): string[] {
  const usable: Record<string, true> = {};
  for (const model of catalog) {
    if (model.available === false) continue;
    usable[model.backendKind] = true;
  }
  return Object.keys(usable);
}

/** Backend kinds that have an enabled agent but no usable model: every
 *  dispatch on those agents fails. Empty means the deployment can run. */
export function blockedBackends(
  agents: ReadonlyArray<{ enabled?: boolean; backendKind: string }>,
  catalog: ReadonlyArray<{ backendKind: string; available?: boolean }>,
): string[] {
  const usable: Record<string, true> = {};
  for (const backend of usableBackends(catalog)) usable[backend] = true;
  const blocked: Record<string, true> = {};
  for (const agent of agents) {
    if (agent.enabled === false) continue;
    if (usable[agent.backendKind]) continue;
    blocked[agent.backendKind] = true;
  }
  return Object.keys(blocked).sort();
}
