---
name: agent-doctor
description: >
  Inspect another agent's workspace and memory when it keeps misbehaving:
  read its workspace files (MEMORY/notes/config), summarize what its
  context has drifted into, and propose concrete corrections. Use when
  a teammate agent repeats the same mistake, answers from stale
  assumptions, or needs a reset recommendation.
user_invocable: true
---

# Agent Doctor

Raft's troubleshooting insight: the correction loop is *another agent
reads the sick one's memory*. This skill operationalizes it.

## When to use

- An agent keeps repeating the same mistake after in-thread corrections
- Its answers smell like stale context (references that no longer exist)
- You want a second opinion before doing a session reset on someone

## Procedure

1. **Locate the workspace**: agent workspaces live under the backend
   data dir, one folder per agent id (`agents/<agentId>/`). Ask the
   user (or check the agent record) for the id if unknown.
2. **Read the memory first**: MEMORY/notes files, SOUL/identity files,
   any journal. Do not skim — quote the exact lines that look drifted.
3. **Read recent session facts**: the conversation ledger is the shared
   truth; the agent's own context tree is its private view. Compare:
   what does it believe that the ledger contradicts?
4. **Report, don't edit**: propose corrections as a list (file, line,
   what to change). The sick agent (or its human) applies them — a
   doctor that rewrites the patient's memory unbidden is a hazard.
5. **Escalation ladder**: in-thread correction → memory edit via the
   proposal above → session reset (context clears, workspace persists)
   → full reset (last resort; destroys workspace memory too).

## Boundaries

- Never edit another agent's workspace files directly; propose, let the
  owner commit (the same discipline as config proposals).
- Do not diagnose an agent whose runs are merely *busy* — that is the
  triage table's job, not memory analysis.
