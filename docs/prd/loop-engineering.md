# PRD: Loop — Unified Work System

## Problem Statement

Engineers juggle two systems: a Kanban for manual work, and the desire to automate repetitive discovery (CI triage, PR review, issue labelling). These feel like separate products — one you push tasks through, one runs on a schedule. The cognitive split is unnecessary. Every piece of work — human-authored or cron-discovered — goes through the same lifecycle: identify → act → verify → decide.

The existing Issue/Kanban system is custom-built for manual code-fix workflows with per-column agent configuration. It can't express "label this issue" or "remind reviewers about stale PRs" without forcing those into the code-fix mould. And it can't schedule itself — CronJob exists separately but has no discovery capability.

## Solution

**Loop is the unified work system.** `/loops` becomes the single work entry point alongside `/conversations`. The `/issues` Kanban page is subsumed — a manual work pool is just a Loop with trigger=manual and no discovery skill.

Users create Loops via natural-language intent: "check CI every morning, fix simple failures." The system interprets the intent, generates config (schedule, skills, safety, budget), and the user reviews before activating.

Loop items live in STATE.md files — not database tables. One file, three consumers: discovery agent writes findings, LoopRunner reads it to decide next steps, human reviews it in the review queue. Zero schema migrations, zero new tables.

The single database change: CronJob gains `loop_config_path TEXT` (nullable). When set, cron fires call `loopStep(loopConfigPath)`.

## User Stories

### Creation
1. As an engineer, I want to describe what I want in natural language, so that I don't need to learn scheduling syntax or skill names.
2. As an engineer, I want the system to generate a Loop config from my intent, so that I review and confirm rather than configure from scratch.
3. As an engineer, I want to adjust generated config before activating, so that I retain control over safety-critical parameters.
4. As an engineer, I want to create a manual-work Loop for ad-hoc tasks, so that all work flows through one system.

### Dashboard
5. As an engineer, I want to see all Loops with items awaiting review, token spend, and last run time, so that I know which Loops need attention.
6. As an engineer, I want to pause, resume, or delete a Loop, so that I can control automation.
7. As an engineer, I want to manually trigger a Loop run, so that I can verify config changes immediately.

### Review Queue
8. As an engineer, I want to see all items awaiting review with generator diff, evaluator verdict, and evidence, so that I can make informed decisions.
9. As an engineer, I want to approve an item with one click, so that approved work clears the queue.
10. As an engineer, I want to reject an item with feedback, so that it moves to inbox for later.
11. As an engineer, I want to promote an item to deeper investigation, so that complex findings don't block the queue.
12. As an engineer, I want to see the full evidence chain per item, so that I can assess Loop reliability.

### History
13. As an engineer, I want run history showing discovered items and outcomes, so that I can audit Loop behaviour.
14. As an engineer, I want post-run critique in history, so that I can progressively tune discovery.

### Safety
15. As an engineer, I want daily token budget cap that auto-pauses the Loop, so that bugs can't burn tokens overnight.
16. As an engineer, I want path denylists enforced, so that sensitive files are never auto-edited.
17. As an engineer, I want auto-merge to default to "never", so that no code ships without review.

## Implementation Decisions

### Loop replaces Issue/Kanban as top-level nav

`/issues` disappears. `/loops` and `/conversations` are the two top-level work concepts. Manual work pool = Loop with trigger=manual and no discovery. Old Kanban semantics replaced by Loop step machine. Existing Issue migration out of scope — read-only during transition.

### Items in STATE.md, not DB

No table for Loop items. STATE.md is the runtime state, audit log, and human-readable report:

```
| id | source | summary | step | attempt | result |
| f-1| ci/4821| auth flaky | awaiting_review | 1 | PASS |
```

### Config in files; CronJob references path

Loop config in `.loop/` directory (config.yml, constraints.md, skills/, STATE.md). CronJob gains `loop_config_path TEXT` column. No other DB changes.

### Step state machine (prototype-validated)

```
triaged → fixing → verifying → awaiting_review
                                    ├─ resolved
                                    ├─ inbox
                                    └─ promoted
```

Pure reducer `loopReducer(state, action) → state` is the test seam.

### Generator/Evaluator: separate AgentSessions

Different models, different prompts, different sessionIds. Evaluator defaults to doubt, verifies by executing via MCP. Structured verdict parsed into item result.

### loopStep(): stateless, called per trigger

Not a continuous generator. Called once per cron tick or human review action. Reads STATE.md, runs one step, writes back. Human gate handled by STATE.md persisting across restarts.

### Goal is ephemeral

Goal = natural-language input in creation dialog, translated to Loop config, then discarded. Not a domain entity.

## Testing Decisions

Test the pure reducer — no I/O, no AgentSession. Assert state transitions:
- TICK: triaged → fixing
- Evaluator PASS: verifying → awaiting_review
- Evaluator REJECT with retries left: verifying → fixing
- Evaluator REJECT exhausted: verifying → inbox
- Human actions valid only from awaiting_review

Prior art: `packages/framework/src/create-agent.test.ts` (scripted inputs, asserted outputs).

## Out of Scope

- Migration of existing Issue data to Loop format
- Multi-step Orchestrator workflows in Loop
- Loop template marketplace or pattern browser
- Automatic git worktree management
- Multi-Loop coordination

## Further Notes

Key product decision: `/issues` disappears. One interface, one mental model, one review queue. File-based state over DB tables is deliberate — portable, human-debuggable, schema-free. Design lineage: loop-engineering reference repo (Cobus Greyling), Loop Engineering essay (Addy Osmani), generator/evaluator findings (Prithvi Rajasekaran, Anthropic).
