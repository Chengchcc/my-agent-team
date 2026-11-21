/** ADR 0072/0074: what a FRONT desk may not touch.
 *
 *  Two rounds of live evidence shaped this list. First the write tools
 *  (`bash, eval, write, edit`): the front desk edited a worker's files and
 *  reported "已加好". Then the investigation tools (`read, ls, grep, glob,
 *  tree, web_*, browser`): asked to study a repository, it opened its OWN
 *  empty workspace, hit `path escapes workspace` and ENOENT on every attempt,
 *  and never dispatched (2026-11-21).
 *
 *  Its workspace holds no code, so reading there buys nothing; product
 *  knowledge comes from the knowledge tools and repository questions are the
 *  team's work. `eval` is on the list because it is arbitrary JS with
 *  node:fs — the escape hatch that wrote a file after bash was denied. */
export const FRONT_DESK_DISABLED_TOOLS: readonly string[] = [
  "bash",
  "eval",
  "write",
  "edit",
  "read",
  "ls",
  "grep",
  "glob",
  "tree",
  "web_search",
  "web_fetch",
  "browser",
];
