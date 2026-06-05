---
title: "Summary: Checkpointer"
type: summary
created: 2026-06-05
source: raw/articles/04-checkpointer.md
tags: [checkpointer, persistence, interrupt]
---

# 04 — Checkpointer

Framework internal capability for persistence and recoverability. 3-tier interface: mandatory save/load, paired saveInterrupt/consumeInterrupt, paired appendEvent/readEvents. Capability detection at construction — partial pairs throw immediately.

**5 save points** at tool boundaries ensure messages are always in legal API state. Interrupt save is the exception (last message = assistant(tool_use)) — resume fills the gap.

`InterruptSignal` is a special Error class. Recognition boundary is strict: only from `tool.execute()`. Plugin hooks throwing it → regular error handling. `withPermission()` is the recommended wrapper pattern for gating tools.
