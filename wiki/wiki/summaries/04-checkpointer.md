---
title: "Summary: Checkpointer"
type: summary
created: 2026-06-05
updated: 2026-06-09
source: raw/articles/04-checkpointer.md
tags: [checkpointer, persistence, interrupt]
---

# 04 — Checkpointer

Framework internal capability for persistence and recoverability. 3-tier interface: mandatory save/load, paired saveInterrupt/consumeInterrupt, paired appendEvent/readEvents. Capability detection at construction — partial pairs throw immediately.

**M9 scope narrowing**: Tier 3 (`appendEvent`/`readEvents`) demoted to optional internal audit. UX event projection is now owned by [[EventLog]] — an independent port extracted from Checkpointer, owned by backend, with subscribe capability and `thread_id` field. Checkpointer remains the sole authority for agent resume (stores trimmed input state; EventLog stores raw uncut events).

**Sandbox isolation**: current in-process/file-based checkpointer implementations will break under sandboxed runners. Long-term direction: Checkpointer HTTP/RPC sub-service. Must complete before sandbox runners are enabled.

**5 save points** at tool boundaries ensure messages are always in legal API state. `InterruptSignal` recognition is strict: only from `tool.execute()`.
