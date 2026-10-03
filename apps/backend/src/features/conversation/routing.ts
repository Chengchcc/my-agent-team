/** ADR 0041: response routing, derived from member count — no stored mode.
 *
 *  - 1 member (e2e conversation): every message triggers that agent; an
 *    explicit mention of someone else does not (today's lark-group guard).
 *  - 2+ members (room): only a mention of a member triggers that member;
 *    un-mentioned messages are ledger-only (shared timeline, no run).
 *  - System inputs (reminder delivery, workflow dispatch) MUST carry
 *    addressedTo naming their target — the room rule would otherwise
 *    swallow them forever. A target that is no longer a member is dropped
 *    (the caller logs); firing into an ownerless branch is worse.
 *
 *  Pure on purpose: this is the seam the member model hangs off. */

export function resolveTrigger(input: {
  /** The conversation's agent members (from conversation_member). */
  members: readonly string[];
  /** Explicit targets carried by the input (@mentions, system authors). */
  addressedTo?: readonly string[] | undefined;
}): string[] {
  const { members, addressedTo } = input;
  if (members.length === 0) return [];
  if (members.length === 1) {
    const only = members[0]!;
    return (addressedTo ?? [only]).includes(only) ? [only] : [];
  }
  if (!addressedTo) return [];
  return members.filter((m) => addressedTo.includes(m));
}
