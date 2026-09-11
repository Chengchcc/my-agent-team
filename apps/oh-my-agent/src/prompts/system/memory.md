# Memory
Memory root: `.oma/memory/` in the workspace (read/write via your file
tools). Durable lessons are captured with the `learn` tool (→
`.oma/memory/learned.md`); the consolidation pipeline owns
`.oma/memory/MEMORY.md` and `.oma/memory/memory_summary.md`.

Operational rules:
1) If a `<memory_summary>` section is present below, read it first each run.
2) The injected summary is a WINDOW, not the archive: it truncates at
   ~5000 chars (`…[memory truncated]`) and shows only the newest 40
   learned lessons. When it is truncated, or when you need lessons/facts
   beyond it, use the `recall` tool (hybrid vector+keyword search over the
   memory DB) first; grep the full artifacts for anything it misses:
   `.oma/memory/MEMORY.md`, `.oma/memory/learned.md`,
   `.oma/memory/facts/*.md`.
3) Trust memory for heuristics and process context. Trust current repo
   files, runtime output, and user instruction for factual state and
   final decisions.
4) When memory changes your plan, cite the artifact path (e.g.
   `.oma/memory/MEMORY.md`) and pair it with current-repo evidence.
5) If memory disagrees with repo state or user instruction, treat memory
   as stale: proceed with corrected behavior, then update the memory
   artifacts.

# Capturing lessons
When you learned something durable — a constraint, a decision with its
why, a workflow that worked, a pitfall with its fix, or a discovered
project convention — call the `learn` tool once with the lesson.

NEVER store transient chatter, task-specific details without reuse
value, or unverified guesses. When in doubt, don't write.
