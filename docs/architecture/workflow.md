---
title: Workflow Engine
description: Declarative Agentic Workflow DSL (packages/workflow), 5 node types, 13-op JSON-Logic, parallel waves, rework attempts & #budget gates, sandboxed script runner, cron/webhook triggers, and artifacts://
tags: [workflow, artifacts, backend, sandbox]
---

# Workflow Engine

CrewDesk's Agentic Workflow system has two cleanly separated layers: **`packages/workflow`** (pure domain DSL, validator, JSON-Logic evaluator, DAG engine, rework planner) and **`apps/backend/src/features/workflow`** (persistent execution engine, node runners, cron/webhook triggers, HTTP API, MCP server), paired with **`apps/backend/src/features/artifact`** for typed `artifacts://` handoffs between nodes and rooms.

> **Not to be confused with Oma Dynamic Orchestration (`orchestrate`):** This document covers Product Backend's **declarative, durable, scheduled/HITL `Workflow`** (`*.workflow.json`). For ephemeral JS-based subagent pipelines inside a single Oma coding session (`orchestrate` tool / TUI `/orchestrate` / `.oma/orchestrations/*.js`), see [Oma Runtime — Delegation Fan-Out & Dynamic Orchestration](./oma-runtime.md#delegation-fan-out--dynamic-orchestration-coredelegation-coreorchestrate).

## Authoritative files

- `packages/workflow/src/types.ts` & `parse.ts` — `WorkflowDefinition` (`version: 1`) and `parseWorkflow()` validator
- `packages/workflow/src/json-logic.ts` — 13-operator `evalJsonLogic()` subset
- `packages/workflow/src/schema.ts` — JSON Schema validation subset (`validateBySchema`)
- `packages/workflow/src/graph.ts` & `engine.ts` — `routeOutgoing()`, `mergeInputs()`, `computeNext()`
- `packages/workflow/src/rework.ts` — `planRework()`, `deriveRework()`, synthetic `${nodeId}#budget` gates
- `apps/backend/src/features/workflow/service.ts` — Persistent execution driver, parallel waves, retries, cancel, boot `recover()`
- `apps/backend/src/features/workflow/node-runners.ts` — `agent`, `script`, and `human` node executors
- `apps/backend/src/features/workflow/trigger-scheduler.ts` — `fs.watch` + `Bun.cron` scheduler with 3-failure circuit breaker
- `apps/backend/src/features/workflow/http.ts` & `mcp.ts` — REST/webhook endpoints and `workflow_{read,write}` MCP server
- `apps/backend/src/features/artifact/domain.ts` & `adapter-fs.ts` & `adapter-sqlite-index.ts` & `http.ts` — `artifacts://` disk storage, SHA-256 verification, and SQLite provenance index

## Pure DSL & Parse-Time Invariants (`packages/workflow`)

Workflow definitions live on disk as `<dataDir>/workflows/<id>.workflow.json` (`WORKFLOW_ID_RE = /^[A-Za-z0-9._-]+$/`; empty directories auto-seed showcase templates from `apps/backend/src/features/workflow/showcase/`).

### 5 Node Types
| Type | Key Fields | Rules |
|---|---|---|
| `start` | `id` | Exactly 1 per workflow; entry point. |
| `end` | `id`, `status` (non-empty string) | Terminal exit label (`success`, `failure`, or custom). |
| `agent` | `agentId?`, `model?`, `prompt?`, `repo?` | Must supply `agentId` OR both `model` + `prompt`. |
| `script` | `code`, `runtime?: "bun"`, `timeoutMs?` | Non-empty JS/TS code; executed inside `@chengchenccc/sandbox`. |
| `human` | `question?`, `form?: Record<string, FormField>`, `timeoutMs?` | Form field types: `string \| textarea \| number \| enum \| date \| boolean`. |

Common node fields: `id` (`/^[a-zA-Z0-9_-]+$/`), `input?`, `output?`, `inputSchema?`, `outputSchema?`, `retry?: number | { maxAttempts?, intervalMs?, backoff? }`, `join?: "any" | "all"` (default `"any"`).

### Static Validation (`parseWorkflow`)
- `version === 1`, unique node IDs, all edge endpoints exist, every non-start node reachable from `start` over `forwardEdges`.
- **Forward edges must be acyclic** (`topoSort` throws `GraphCycleError`).
- **Rework edges (`kind: "rework"`):** must point strictly upstream (`descendantsOf(def, edge.to).has(edge.from)`) and must declare `budget: { maxAttempts >= 1, onExhausted: "fail" | "human" }`. Forward edges must not declare `budget`.
- **JSON-Logic whitelist (`OPS`, 13 operators):** `var`, `==`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `and`, `or`, `not`, `if` (strictly 3-arg), `!!`. Unknown operators fail at parse time (preventing fail-open plain-object truthiness). `<nodeId>.output.<field>` references are checked against declared `output` hints / human `form` keys.

## Routing, Parallel Waves & Rework Attempts (ADRs 0042, 0045)

- **Frozen routing (`routeOutgoing`):** outgoing forward edges evaluate once at node completion and freeze into `workflow_node_run.routed_to` (never recomputed). Supports `output.nextNode` override (validated against forward edges). Human answers (`{ answers: [...] }`) flatten to `output[id]` at route time only.
- **Input merge (`mergeInputs`):** merges `trigger` → `store` → live `completions` in `order` (later wins) while stripping `nextNode`, `__proto__`, `constructor`, and `prototype`.
- **Join semantics & parallel waves (`computeNext` + `drive()`):**
  - A node is ready when any incoming edge routed to it AND (`join !== "all"` OR every incoming edge's `from` is completed).
  - If any ready node is `end`, returns `{ kind: "terminal", exit }`.
  - `drive()` executes all ready nodes in a wave concurrently via `Promise.allSettled`, then applies results deterministically in wave order. Sibling completions still persist even if one node fails or parks on a human gate.
- **Rework as new attempts (`rework.ts`):**
  - When a `kind: "rework"` edge fires, `edge.to` and all of its forward descendants are marked `superseded` in `workflow_node_run` and new rows execute with `{ attempt, rework: { from, reason } }` (`reason` clipped to `2000 chars`).
  - `deriveRework()` reconstructs pending rework purely from persisted `workflow_node_run` rows (crash-safe).
  - If `attempt > maxAttempts + granted` and `onExhausted === "human"`, parks a synthetic human budget gate at node id `${nodeId}#budget` expecting `{ decision: "grant" | "reject" }`; `"grant"` adds `+1` budget and resumes, `"reject"` fails the execution.

## Backend Execution & Node Runners (`features/workflow/`)

- **Single-flight:** `startExecution()` rejects (`409`) if any `status === "running"` execution exists for the same `workflowId`. Definitions are snapshotted into `workflow_execution.definition` at start time.
- **Retries (`runNodeWithRetry`):** backoff delay `intervalMs * backoff ** attempt`. For `agent` nodes, `outputSchema` validation failures trigger retries with a cleared `runId` and the error appended to the prompt.
- **`agent` runner (`runAgentNode`):**
  - Creates a hidden conversation `workflow:<executionId>:<nodeId>` (`origin: "workflow"`). Repo-aware nodes (`node.repo`) verify the agent is attached to that project.
  - Posts with `permissionMode: "yolo"` and `authorization: "system"`. Reuses persisted `nodeRun.runId` on crash recovery.
  - Polls every `1s` up to `agentNodeTimeoutMs` (default `10 min`); clock pauses while `agent_run.status === "waiting"`. Parses first `{...}` JSON object from assistant text (stripping fences).
- **`script` runner (`node-runners.ts`):**
  - **Disabled by default.** Requires `WORKFLOW_SCRIPTS_ENABLED=1` (or `true`). When disabled, script nodes throw and `GET /api/workflow-definitions` marks `scriptNodesBlocked: true`.
  - Executes via `@chengchenccc/sandbox` (`timeoutMs` default `60_000`, `isolation: { noNetwork: true, denyReadDirs }` defaulting to `[dataDir, resolve(cwd, ".env"), ...WORKFLOW_SANDBOX_DENY_READ]`). Host `store` is not exposed inside the sandbox.
- **`human` runner & expiry:** persists `workflow_pending_human` (replacing prior row on rework). A 30s background timer (`expireHumanTimeouts`) atomically fails expired non-`#budget` human tasks.
- **Boot recovery (`recover()`):** runs **after** `agentRunExecution.recover()` and resumes all DB `status === "running"` executions.

## Triggers (Cron & Webhooks)

- **Cron scheduler (`trigger-scheduler.ts`):** watches `<dataDir>/workflows` (`fs.watch`, 300ms debounce), registers `Bun.cron` schedules for enabled cron triggers, skips duplicate `def.id`s, enforces in-memory + DB single-flight, and trips a **circuit breaker after `3` consecutive failed executions** (`TRIGGER_CONSECUTIVE_FAILURE_LIMIT = 3`, cleared by a successful manual run).
- **Webhooks (`POST /api/workflow-triggers/:workflowId`):** exempt from global `BACKEND_AUTH_TOKEN`, authenticated via constant-time `safeTokenEqual` against per-workflow `x-trigger-token` (rotated via `POST /api/workflow-definitions/:workflowId/trigger-token`, stored in sealed `settings` under `workflow.trigger_token.<id>`).

## Artifacts (`features/artifact/`)

- **URI scheme:** `artifacts://<folder>/<filename>` (rejects absolute paths, Windows drives, `.` / `..`, `*`, or `< 2` segments).
- **Storage + index:** raw decoded bytes (`utf8 | base64`) write to `<dataDir>/artifacts/<folder>/<filename>` with sidecar `.meta.json` (`{ encoding, source, updatedAt, sha256 }`). Metadata and cross-surface FKs (`run_id`, `conversation_id`, `requirement_id`, `workflow_execution_id`, `project_id`, `agent_id`) persist in SQLite `artifact` (ADR 0082).
- **Provenance freeze (`enrichSource`):** transitively fills missing FKs at write time from `agent_run → workflow_node_run → workflow_execution → conversation → requirement`. Boot runs `artifactService.backfill()`.
- **Integrity & retention:** `GET /api/artifacts/verify?url=` recomputes SHA-256 against `.meta.json` (fails if sidecar missing). `ARTIFACT_RETENTION_DAYS > 0` sweeps old artifacts at boot and every 24h (default `0` = keep forever).

## See also

- [Data Model](./data-model.md) — `workflow_*` and `artifact` table schemas
- [Security Model](./security-model.md) — `@chengchenccc/sandbox` isolation and open human-form/JSON-Logic debt
- [Team Coordination](./team-coordination.md) — `workflow_write` proposal flow ("suggest ≠ save")
