# Self-Evolution System: Fix & Iteration Design

## Implementation Status (2026-05-09)

| Phase | Status | Key Deliverables |
|---|---|---|
| **A** P0 Fixes | Done | TUI decoupling, feedback path, skill_name validation, neutral aborted, dedup regex, store injection, Tier 2 real data |
| **B** Defense | Done | IdleGate, ReviewSlot, ReviewBackoff, CircuitBreaker, per-signal cooldown, sha1 fingerprint |
| **C** Lifecycle | Done | TaskRunner (configurable hard abort), TurnSettledDetector (loop_settled), expanded outcome union |
| **D** Queue | Done | Tiered PersistentQueue (tier0/2/3/housekeeping), TierBreaker, Drainer (kind-based dispatchers), Supervisor, SettleBus |
| **E** Triggers | Done | IdleTrigger, EventTrigger, CronTriggers, ThresholdTrigger, ManualTrigger, AutoAcceptRunner (dispatcher) |
| **F** Prompt Self-Evolve | Pending | Tier3OptRunner, Tier3AbRunner, Tier2 verdict dispatcher, CronScheduler module |
| **G-L** | Deferred | Trace sampling, skill graph, verdict calibration, user feedback, multi-agent voting, shadow deployment |

## Problem Statement

The self-evolution system was structurally complete but operationally broken. Tier 2 ran on empty data, review prompts lacked context, evolution was coupled to TUI, feedback files polluted cwd, skill names allowed path traversal, and aborted runs were miscounted as failures. All P0 issues fixed in Phase A, defense layers added in B, lifecycle convergence in C, tiered queue in D, trigger framework in E.

## Confirmed Issues (verified against codebase)

| ID | Issue | File | Line | Severity |
|---|---|---|---|---|
| B7 | skill_name used in path join without validation | review-tools.ts | 52 | Critical |
| B10 | feedback writes to `process.cwd()` | effectiveness-tracker.ts | 84-85 | Critical |
| B4 | Tier 2 receives empty stats + empty traces | evolution/index.ts | 100-101 | High |
| B1 | Review prompt has no trace context (placeholders empty) | review-agent.ts | 206 | High |
| B2 | reviewInterval never reaches prompt templates | review-agent.ts | 206 | High |
| B13 | evolution/index.ts and agent-middleware.ts import useTuiStore directly | index.ts:8, agent-middleware.ts:8 | — | Medium |
| B11 | aborted/cleared counted as failed | effectiveness-tracker.ts | 52 | Medium |
| B6 | Global throttle (single lastReviewAt) starves signals | nudge-engine.ts | 30 | Medium |
| C1 | Dedup regex `/description:\s*"([^"]+)"/` mismatches unquoted output | review-tools.ts | 71 vs 95 | Medium |
| B12 | NudgeEngine loads state synchronously in constructor | nudge-engine.ts | 146-154 | Low |
| B5 | activatedSkills snapshot from cache, not actual injection set | agent-middleware.ts | 33 | Low |
| D2 | Fingerprint is just sorted error tool names — too weak | nudge-engine.ts | 117-125 | Low |

## Architecture Decision: Phase-Based SDD with Worktrees

Each phase develops in an isolated git worktree. When all tasks in a phase pass verification, the worktree merges to master via PR. This ensures:
- Master is always green
- Phases are independently reviewable
- Failures don't contaminate other phases
- Each merge is atomic and reversible

## Phase Roadmap

### Phase A — P0 Emergency Fixes (T1-T7)

**Goal**: Fix all correctness and security issues. No new features.

| Task | Fix | LOC est. |
|---|---|---|
| T1 | Decouple evolution from TUI — callback injection | ~30 |
| T2 | Feedback path → `~/.my-agent/feedback/` | ~10 |
| T3 | skill_name validation regex + `..` guard | ~15 |
| T4 | aborted/cleared/compacted_mid = neutral outcome | ~10 |
| T5 | Dedup regex fix + write quoted frontmatter | ~15 |
| T6 | Inject TraceStore + reviewInterval into review prompt | ~40 |
| T7 | Tier 2 loads real stats + traces from store | ~30 |

**Dependencies**: T6 must precede T7 (T7 uses store injected in T6).

**Verification**:
- `tsc --noEmit` passes
- `bun test src/evolution` passes
- `~/.my-agent/feedback/feedback-evals.json` exists after review (not in cwd)
- review prompt contains trace summaries and reviewInterval
- Tier 2 verdict.reason references trace data (not fallback text)

### Phase B — Defense Layer (L1-L5 + CircuitBreaker)

**Goal**: Prevent review tasks from starving, colliding, or retrying infinitely.

| Fix | Description |
|---|---|
| L1 IdleGate | Block review while streaming/compacting |
| L2 Global exponential backoff | 30s → 1m → 2m → 5m → cap 15m |
| L3 Per-signal cooldown | error_burst 2m / complex 10m / periodic 30m |
| L4 Fingerprint upgrade | sha1(signal + sortedErrorTools + bucket(turnIndex/5) + sortedActiveSkills) |
| L5 ReviewSlot | Single pending slot with priority override |
| CircuitBreaker | 3 consecutive failures → 1h pause; state in `~/.my-agent/state/breaker.json` |

**Depends on**: Phase A (T1 decouples TUI, making IdleGate possible).

### Phase C — Lifecycle Convergence

**Goal**: Handle mid-review user input and define when a loop is "settled".

| Component | Description |
|---|---|
| ReviewRunner | Soft cancel (checked at turn boundaries) + hard abort (10s timeout) |
| TurnSettledDetector | rootRunning + subRunningCount + 500ms quiet → `loop_settled` event |
| Outcome union expansion | Add `aborted_by_review`, `compacted_mid`, `cleared`, `network_error` |

**Depends on**: Phase B (IdleGate and ReviewSlot are prerequisites).

### Phase D — Persistent Task Queue

**Goal**: Survive process crashes; shared execution channel for all triggers.

- Directory: `~/.my-agent/evolution/{queue,inflight,dead}/`
- File locking with O_EXCL + heartbeat mtime + zombie recovery
- Exponential backoff with jitter; 5 attempts max → dead/
- API: `enqueue`, `claim`, `complete`, `fail`, `recoverInflight`

**Depends on**: Phase B (circuit breaker and backoff are prerequisites).

### Phase E — Multi-Trigger Scheduling

**Goal**: Five trigger types sharing one execution channel.

| Trigger | Timing | Force | Purpose |
|---|---|---|---|
| IdleTrigger | streaming=false for 30s | no | Default path |
| EventTrigger | loop_settled + 1s | no | Immediate response |
| CronTrigger | daily 03:00 / 15min / weekly Sun 04:00 | no | Fallback + weekly Tier 3 |
| ThresholdTrigger | queue.size() >= 10 | no | Backlog protection |
| ManualTrigger | /review run-now | yes | Debug, bypasses IdleGate |

**Depends on**: Phase C (TurnSettledDetector), Phase D (persistent queue).

### Phase F — Tier 3 Prompt Self-Evolution

**Goal**: Close the "AI improves AI" loop — auto-optimize review/analyzer prompts.

- Weekly cron drives prompt optimizer agent
- A/B shadow evaluation: old vs new prompt
- Auto-promote on win; auto-dead-pool on loss
- Weekly promote cap + 14-day cooldown + CircuitBreaker

**Depends on**: Phase E (scheduling infrastructure).

## Merge Strategy

Each phase = one worktree = one PR to master. Merge order:

```
Phase A (P0) → master
Phase B       → master (after A merged)
Phase C       → master (after B merged)
Phase D       → master (after B merged, parallel with C)
Phase E       → master (after C + D merged)
Phase F       → master (after E merged)
```

Phases C and D can be developed in parallel (both depend on B, not each other). If both touch `evolution/index.ts`, merge C first then rebase D.

## Architecture Diagrams

### Producer / Consumer / Defense / Scheduler

```
┌─ Producer (src/trace/) ─┐     ┌─ Defense Layers (L1-L5) ─┐
│ AgentMiddleware          │     │ L1 IdleGate               │
│ TraceStore (NDJSON)      │ ──→ │ L2 指数退避 30s→15min      │
│ Redactor                 │     │ L3 per-signal cooldown    │
│ NudgeEngine              │     │ L4 Fingerprint LRU         │
└──────────────────────────┘     │ L5 ReviewSlot              │
                                 │ CircuitBreaker            │
                                 └───────────────────────────┘
                                            │
              ┌─ Scheduler (Phase E) ─┐     │
              │ 5 trigger → Drainer   │ ←───┘
              └───────────────────────┘
                       │
┌─ Persistent Queue (Phase D) ─┐
│ queue/ → inflight/ → dead/   │
└──────────────────────────────┘
                       │
┌─ Consumer (src/evolution/) ─┐
│ Tier 0 forkReviewAgent      │
│ Tier 1 EffectivenessTracker │
│ Tier 2 forkSkillAnalysis    │
│ Tier 3 PromptOptimizer      │
│ Auto-Accept 48h→kept        │
└──────────────────────────────┘
```

### Defense Decision Tree

```
NudgeSignal → L4(Fingerprint?) → L3(Cooldown?) → L2(Backoff?) → CB(Open?)
  → L1(Streaming?) → L5(Slot?) → Queue or Execute
```

### Queue State Machine

```
[*] → Queued → Inflight → Done
             ↘ Inflight → Dead (≥5 fails)
             ↘ Inflight → Queued (heartbeat>10min)
```

### File Layout

```
~/.my-agent/
├── traces/           TraceStore NDJSON
├── skills/           auto-generated skills
├── feedback/         feedback-evals.json
├── state/            breaker.json, nudge.json, feature-flags.json
├── evolution/        Phase D queue
│   ├── queue/
│   ├── inflight/
│   └── dead/
└── metrics.ndjson    per-phase metrics
```

## Out of Scope for This Design

- Phase G (Trace sampling), H (skill graph), I (verdict calibration), J (user feedback), K (multi-agent voting), L (shadow deployment) — deferred to future specs.
