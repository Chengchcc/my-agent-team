/** Which native session a dispatch should continue in (#25).
 *
 *  Two identities must not be confused:
 *  - `run.nativeSessionRef` — the session THIS run bound, written by the ACP
 *    adapter when session/new or session/load succeeded. A re-dispatched run
 *    (HITL resume, crash recovery) continues in exactly this one.
 *  - `branch.cliSessionRef` — the NEXT fresh run's continuation pointer,
 *    scoped to `<kind>[/<harness>]:<ref>`, and only written at a terminal
 *    commit. The harness is part of the scope because every harness now rides
 *    the `acp` kind: with the kind alone, a session written by claude was
 *    handed to oma (and vice versa) after a harness switch.
 *
 *  Before this existed, a run that died parked had no ref of its own, so
 *  recovery read the branch pointer (still the PREVIOUS turn's session) or
 *  fell through to the adapter's "adopt the newest interrupted session in
 *  this cwd" scan — both guesses. */

/** The scope a branch pointer must carry to be reusable. Writing and reading
 *  both go through here so the two can never drift apart.
 *
 *  `harness` absent keeps the legacy kind-only scope: a config that never
 *  names a harness has no harness identity to key on, so demanding one would
 *  drop continuity for no gain. */
export function continuationPrefix(kind: string, harness: string | undefined): string {
  return harness ? `${kind}/${harness}:` : `${kind}:`;
}

export interface ContinuationRefInput {
  /** The run's own bound session, raw (no kind prefix). */
  readonly runNativeRef: string | null;
  /** The branch's pointer, kind-scoped. */
  readonly branchRef: string | null | undefined;
  /** The run's backend kind, for the branch pointer's scope check. */
  readonly kindPrefix: string;
}

export function resolveContinuationRef(input: ContinuationRefInput): string | undefined {
  if (input.runNativeRef) return input.runNativeRef;
  // A branch pointer written by another backend is junk to this CLI (pi exits
  // empty on a foreign --session id): forward it only under our own scope.
  const branchRef = input.branchRef;
  if (branchRef === undefined || branchRef === null) return undefined;
  return branchRef.startsWith(input.kindPrefix)
    ? branchRef.slice(input.kindPrefix.length)
    : undefined;
}
