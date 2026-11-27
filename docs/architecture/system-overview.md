---
title: System Overview
description: End-to-end architecture of CrewDesk — PA + Worker team topology, process container map, ownership boundaries, the single Agent Run execution pipeline, failure rules, and global invariants
tags: [overview, runtime, backend]
---

# System Overview

> **Language:** **English (canonical)** · [简体中文](./system-overview.zh-CN.md)

CrewDesk (`my-agent-team`) is a single-node, Bun + SQLite control plane that coordinates a team of AI coding agents across four CLI harnesses (`oma`, `claude`, `pi`, `omp`) behind one Agent Client Protocol (ACP) rail and exposes one synchronized truth to Web, Lark/Feishu, and workspace PTY terminals.

## Authoritative files

- `apps/backend/src/main.ts` — Process startup order and graceful `SIGTERM`/`SIGINT` drain
- `apps/backend/src/bootstrap/services.ts` — Process-level singletons (`backend.db`, settings, MCP client manager, ops store, Lark supervisor)
- `apps/backend/src/bootstrap/features.ts` — Composition root assembling all 22 feature routers, ACP backend, Product MCP servers, and background loops
- `apps/backend/src/app.ts` — Elysia HTTP/WS router assembly, global `authGuard`, and global `onError` JSON contract
- `apps/backend/src/features/agent-run/execution-dispatch.ts` — 9-stage Run dispatch state machine
- `apps/backend/src/features/agent-run/adapter-sqlite-enqueue.ts` — Atomic `enqueueAndAcquire` transaction
- `apps/backend/src/features/agent-run/adapter-sqlite-runs.ts` — Atomic terminal commit, `failCommit`, and `acquireNextRun`
- `apps/backend/src/features/agent-run/execution-service.ts` — `recover()`, `steer`, `resolveApproval`, `stop`, and `dispose`
- `apps/backend/src/features/agent-run/acp/acp-backend.ts` — Single ACP client driving all four harnesses
- `apps/oh-my-agent/src/core/runtime/create-runtime.ts` — Per-Run `oma` runtime assembly

## Container & Process Topology

```text
CrewDesk Control Plane
───────────────────────────────────────────────────────────────────────────────
Web Console (Next.js 15, :3001) ──HTTP BFF + /ws/ahp + /ws/coding──┐
                                                                   ├─→ Product Backend (Elysia, :3000)
Lark Bot (per-PA process, SDK WS) ──HTTP + /ws/ahp─────────────────┘     │
                                                                         ├── SQLite backend.db (32 tables)
                                                                         ├── Disk: workspaces/, projects/*.git,
                                                                         │         artifacts/, wiki/ (Git), skill-packs/,
                                                                         │         workflows/, mcp-servers.json
                                                                         ├── Coding PTY (bun-pty): shell or `oma` TUI
                                                                         └── 1 ephemeral ACP child per Agent Run:
                                                                               ├─ oma     (oma --mode acp)
                                                                               ├─ claude  (claude-agent-acp)
                                                                               ├─ pi      (pi-acp)
                                                                               └─ omp     (omp acp)

Standalone Oma CLI / TUI (independent — no Product Backend)
───────────────────────────────────────────────────────────────────────────────
User Terminal ──→ oma (tui / print / json) ──→ @chengchenccc/ai (LLM APIs) + local workspace / JSONL sessions
```

- **Surfaces over Product Backend** are **Web** and **Lark Bot**:
  - **Web** never holds backend credentials in the browser; `/api/bff/[...path]` validates the `maw_session` cookie and injects `x-auth-token` server-side. Real-time updates travel over `/ws/ahp` and `/ws/coding/:id` using 60-second single-use tickets; there are no SSE routes left in the backend.
  - **Lark bots** run one process per PA agent (supervised by `DevLarkBotRegistry` in dev or `systemd` template `my-agent-team-lark-bot@<agent>` in production), speak directly to Feishu OpenAPI for streaming CardKit cards, and subscribe to backend state over `/ws/ahp`.
- **Oma (`apps/oh-my-agent`) is NOT a surface client of Product Backend.** In `tui` / `print` / `json` modes it is a self-contained runtime talking directly to LLM providers (`@chengchenccc/ai`) and local workspace/JSONL session files. Inside CrewDesk it runs strictly as a child process — either as an ephemeral ACP harness (`oma --mode acp`) per Agent Run or inside a Coding `bun-pty` terminal pane.

## PA + Worker Team Model

CrewDesk enforces a hard code-level split between two agent roles (ADRs 0049, 0072, 0074):

| Role | Responsibility | Code-enforced boundary |
|---|---|---|
| **Operator (Human)** | Owns configuration, approves irreversible/out-of-scope actions, merges branches, accepts requirements. | Agent config/project/workflow edits land as `proposal` rows ("suggest ≠ save"). |
| **PA / Front Desk** (`role !== "worker"`) | Owns human attention, clarifies intent, creates/tracks Requirements, dispatches workers into child rooms, answers evidence-backed worker questions, maintains the shared Git Wiki. | `FRONT_DESK_DISABLED_TOOLS` strips all 14 execution/file/web/delegation tools (`bash`, `eval`, `read`, `write`, `edit`, `ls`, `grep`, `glob`, `tree`, `web_search`, `web_fetch`, `browser`, `read_image`, `task`). Cannot bypass dispatch. |
| **Worker** (`role === "worker"`) | Executes code, research, and review inside isolated child conversations (`parent_conversation_id`) and requirement git worktrees (`req/<requirementId>`). | Cannot enable Lark (`agentConfigSchema` rejects `worker` + `lark.enabled`). Human messages to a worker in a room reroute to the front desk unless `directToWorker: true`. `project_push` only pushes `agent/<runId>` (never `main`/`master`). Unverified edits trigger a second-member delivery gate warning. |

## Ownership Boundaries

| Fact / Capability | Owner | Notes |
|---|---|---|
| Conversations, ledger, `AgentContext` trees & branches | Product Backend (`backend.db`) | Shared truth across all surfaces |
| Agent Runs, input queue, `pending_action`, telemetry, tool idempotency | Product Backend (`backend.db`) | Execution control plane |
| Requirements, Proposals, Reminders, Proactive ledger, Artifact/Terminal indexes | Product Backend (`backend.db`) | Cross-surface linkage (ADR 0082) |
| Workflow definitions, executions, node runs, human tasks | Product Backend (`workflows/`, `backend.db`) | Pure domain in `packages/workflow` |
| Shared Wiki & Artifact bytes | Product Backend (filesystem) | `<dataDir>/wiki` (Git), `<dataDir>/artifacts` |
| Agent identity, config, skills, MCP catalog | Filesystem (reconciled by Backend) | `agent.yml`, `SOUL.md`, `USER.md`, `mcp-servers.json` |
| Child transcript, tool loop, retries, compaction, native session | Harness child process | Product stores only opaque `cli_session_ref` / `native_session_ref` |
| Surface bindings, delivery dedup, card state, UI drafts | Each Surface | Lark keeps 10 local SQLite tables; Web keeps React Query + AHP mirror |

## Package Dependency Graph

All workspace packages live under `@chengchenccc/`:

- **Leaves (zero workspace deps):** `message`, `config`, `tui`, `sandbox`, `source-fetch`, `workflow`, `api-contract`, `embedding`
- **Runtime & protocol support:** `ai` (3 LLM wire protocols + catalog), `adapter-mcp` (external MCP client), `ahp-client` (WebSocket AHP transport), `test-helpers` (`echoModel()`)
- **Apps:** `backend` (consumes all libraries), `oh-my-agent` (`oma` CLI + runtime), `web` (Next.js 15), `lark-bot` (Feishu adapter)

Cross-package imports must go through package barrels (`index.ts`). Enforced by `bun run audit:workspace` and ESLint.

## The Single Execution Pipeline

Every agent turn — whether triggered by Web, Lark, a PA `dispatch`, a `workflow` agent node, an ambient rule, or a `reminder` — runs through the same pipeline:

```text
Input (Human / Dispatch / Workflow / Ambient Rule / Reminder)
  1. Persist canonical MessageRevision to conversation_ledger
  2. Route targets (conversation_member count + ADR 0049 front-desk reroute + ADR 0046 ambient seam)
  3. enqueueAndAcquire (single SQLite txn: queue row + active-run guard + branch CAS + 20-entry sync + agent_run row)
  4. 9-stage dispatch machine (execution-dispatch.ts):
       load_run → budget_gate → model_preflight → claim_input
       → resolve_workspace → set_product_tools → context_projection
       → backend_execute → settle_outcome → acquire_next
  5. AcpBackend spawns 1 ephemeral harness child over stdio JSON-RPC
  6. Live events fan out to AhpChatWriter (/ws/ahp), telemetry whitelist, and durable pending_action
  7. Child settles to single BackendRunOutcome (completed | failed | aborted | timeout)
  8. Atomic commitCompletedRun txn (ledger + context entries + branch CAS + run status CAS)
  9. Promote next queued input on branch (acquireNextRun) and notify parent dispatcher if dispatched
```

Set `OMA_DEBUG=1` to log each named dispatch stage to stderr.

## Failure Principles

| Failure Point | System Behavior |
|---|---|
| Pre-acceptance failure (budget, model preflight, workspace, spawn, handshake) | Run settles `failed`, bound queue input is `cancelled`, error message committed (`run:<runId>:error`), subscribers notified. |
| Child exits before producing an outcome | Synthesizes `failed` outcome from exit code + stderr tail (unless `isBackendShuttingDown()`, which settles `aborted`). |
| Wire protocol violation or command timeout | Run settles `failed` and child is killed (`SIGTERM` → 3s → `SIGKILL`). |
| Silence watchdog (90s default) or wall-clock cap (30m default) | Exempt while a tool call is open or a `pending_action` is waiting; otherwise calls `backend.stop(runId)` → `aborted`. |
| Terminal commit DB failure | `failCommit` marks Run `commit_failed` with stored `terminal_result`; branch stays occupied until `recover()` retries the commit without re-running the child. |
| Live observer / WebSocket fan-out error | Swallowed; never affects Run execution or settlement. |
| Backend crash or restart mid-run | Boot `recover()` re-dispatches `delivering` inputs, promotes idle pending queues, retries `commit_failed`, re-delivers unnotified worker results, preserves `waiting` runs with open `pending_action`s (ADR 0038), and aborts orphaned live runs. |

## Global Invariants

1. **Human message persistence precedes Run acquisition.** They are separate transactions; a message may exist in the ledger without a Run if enqueue fails.
2. **One active Run per branch** (`running | waiting | commit_failed`), enforced in both SQLite (`idx_agent_run_active_branch`) and `enqueueAndAcquire`.
3. **Terminal `BackendRunOutcome` is the sole authority.** Live events are strictly observational; streaming deltas never enter `conversation_ledger`.
4. **Per-run config snapshot is immutable.** Model ref, system prompt, skill roots, permission mode, tool policy, authorization basis, parent run, and risk flags are frozen at enqueue/acquire time.
5. **Product tool tokens are ephemeral and env-only.** Minted per Run, delivered only via spawn env (`PRODUCT_TOOLS_RUN_TOKEN`), validated by SHA-256 hash in memory, and revoked in `dispatch`'s `finally` block.
6. **Workspace locks serialize shared checkouts.** Runs on a shared requirement worktree (`shared !== false`) hold the per-root lock until settlement; isolated workspaces (`shared: false`) release it after workspace preparation.

## See also

- [Data Model](./data-model.md) — All 32 SQLite tables and transaction boundaries
- [Agent Run Execution](./agent-run-execution.md) — Detailed dispatch stages, HITL parking, and recovery
- [ACP Backend Contract](./acp-backend-contract.md) — The 5-method `AgentBackend` protocol and 4 harnesses
- [Team Coordination](./team-coordination.md) — PA + Worker boundaries, Product MCP, and dispatch lifecycle
- [Operations & Gateway](./operations-and-gateway.md) — DI bootstrap, `oma gateway`, and troubleshooting
