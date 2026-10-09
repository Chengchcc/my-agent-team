/** Is the backend going down right now?
 *
 *  A child that dies from the same signal that is stopping us is not an agent
 *  failure. The order is not ours to choose: the signal reaches the whole
 *  process tree, so the child's pipe often closes BEFORE the parent gets as far
 *  as disposing its runs — and the ACP client then reports
 *  "acp session failed: ACP connection closed" for a run nobody failed at
 *  (#80, observed live 2026-10-09). The dispose path settles every in-flight
 *  run as aborted once it runs, so suppressing the failure here cannot leave an
 *  outcome dangling; it only stops infrastructure from being reported as the
 *  agent's fault.
 *
 *  The flag is explicit rather than inferred from `process` state so tests can
 *  drive both orderings (child first, dispose first) deterministically. */
let shuttingDown = false;

export function setBackendShuttingDown(value: boolean): void {
  shuttingDown = value;
}

export function isBackendShuttingDown(): boolean {
  return shuttingDown;
}
