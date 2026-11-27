---
title: Data Model
description: Authoritative catalog of all 32 SQLite tables in backend.db — domain groupings, semantic columns, partial unique indexes, idempotency keys, atomic transactions, and off-DB files
tags: [backend, data, sqlite, schema]
---

# Data Model

`backend.db` is the single SQLite database (`WAL` mode, `foreign_keys = ON`, file mode `0600`) for Product Backend. `apps/backend/src/infra/db/schema.ts` defines **32 `sqliteTable` tables** and is the sole schema source of truth. (`apps/lark-bot` maintains its own separate 10-table SQLite database per PA agent; see [Lark Surface](./lark-surface.md).)

## Authoritative files

- `apps/backend/src/infra/db/schema.ts` — All 32 `sqliteTable` definitions and `drizzle-zod` select codecs
- `apps/backend/src/infra/sqlite/db.ts` — Database initialization and Drizzle migration runner
- `apps/backend/src/infra/sqlite/db.test.ts` — Schema, dropped-table, and index assertions
- `apps/backend/src/features/agent-run/adapter-sqlite-enqueue.ts` — Atomic `enqueueAndAcquire` transaction
- `apps/backend/src/features/agent-run/adapter-sqlite-runs.ts` — Atomic terminal commit (`commitCompletedRun`), `failCommit`, and `acquireNextRun`
- `apps/backend/src/features/agent-run/adapter-sqlite-actions.ts` — `pending_action` creation, consumption, and escalation
- `apps/backend/src/features/conversation/adapter-sqlite.ts` — Ledger, members, bookmarks, and cascade deletes
- `apps/backend/src/features/agent-context/adapter-sqlite.ts` — Context tree, entries, and branch revision CAS

## Table Inventory (32 Tables)

### Product Facts & Team State (10 tables)

| Table | Purpose & Key Semantics |
|---|---|
| `agents` | Agent registry (`id`, unique `workspace_path`, `archived_at`). `config` JSON is a **materialized cache** of workspace `agent.yml`, never the primary source. |
| `conversation` | Rooms (`conversation_id`, default `agent_id`, `origin`, `title`, `fork_source`/`fork_from_seq`, `project_id` FK `RESTRICT`, `current_requirement_id` FK, `parent_conversation_id` self-FK `CASCADE` for child worker rooms). |
| `conversation_member` | Multi-member room roster `(conversation_id, agent_id)` (ADR 0041). Member count (`1` vs `>=2`) derives response routing. |
| `conversation_ledger` | Append-only canonical message & control log (`seq` autoinc PK, `kind`: `message \| surface.control \| undo`, `content` JSON, `agent_run_id`, `message_index`, `undone`, `saved`). |
| `agent_context_tree` | One isolated context tree per `(conversation_id, agent_id)` (`idx_context_tree_conversation_agent`). |
| `agent_context_entry` | Append-only tree nodes (`entry_id`, self-FK `parent_id`, `type`: `ledger_message \| summary`, `payload` JSON, `ledger_seq`). |
| `agent_context_branch` | Mutable pointer over a tree (`branch_id`, `leaf_entry_id`, `ledger_cursor`, `backend_kind`, `cli_session_ref`, `is_default`, `revision` for CAS). |
| `project` | Git repository entity (`project_id`, unique `name`, `repo_url`, `default_branch`). |
| `skill_pack` | Installed skill packs (`id`, `source_kind`: `builtin \| git \| zip`, `version_ref`, `installed_ref`, `status`, `keep_synced`). |
| `agent_skill_pack` | M:N assignment `(agent_id, pack_id)`. |

### Requirements & Workspaces (4 tables)

| Table | Purpose & Key Semantics |
|---|---|
| `requirement` | Tracked work goals (ADR 0074): `title`, `goal`, `background`, `constraints`, `expected_deliverables`, `acceptance_criteria`, stored `status` (`open \| done \| cancelled`), `project_id`, `origin_conversation_id`/`origin_seq`, `accepted_evidence`, `accepted_at`. Intermediate statuses (`in_progress`, `waiting_user`, `pending_acceptance`) are derived in the read model. |
| `workspace` | Requirement-owned Git worktree checkouts (ADR 0077): `workspace_id`, `project_id` FK, absolute `path`, `branch` (`req/<requirementId>`), `base_ref`, `status` (`open \| released`). Rows outlive deleted checkouts for history. |
| `requirement_workspace` | M:N join `(requirement_id, workspace_id)`. |
| `conversation_requirement` | M:N join `(conversation_id, requirement_id)`. |

### Execution Control Plane & HITL (6 tables)

| Table | Purpose & Key Semantics |
|---|---|
| `agent_run` | Product execution identity (`run_id`, `branch_id` FK `CASCADE`, `conversation_id`, `agent_id`, `model_ref` JSON, `status`, `idempotency_key`, `terminal_result`, `config_revision`, frozen `workspace_*`/`product_tools`/`system_prompt`/`skill_roots`/`permission_mode`/`write_path_policy`/`todo_snapshot`/`workflow_budget_tokens`/`workflow`, `authorization`, `risk`, `parent_run_id`, `requirement_id` FK `SET NULL`, `native_session_ref`, `result_notified_at`, `result_seen_at`). |
| `branch_input_queue` | Durable per-branch input queue (`seq` autoinc PK = strict FIFO ordering, unique `input_id`, `mode`: `normal \| steer \| follow_up`, `status`: `pending \| delivering \| delivered \| cancelled`, full request-time config snapshot including `authorization` and `parent_run_id`). |
| `pending_action` | Durable HITL approvals and asks (`action_id = "<runId>:<callId>"`, `run_id` FK `CASCADE`, `kind`, `payload` JSON, `status`: `pending \| resolved \| cancelled`, `response` JSON, `response_idempotency_key`, `seen_at`, `owner` (`user \| agent:<id>`), `answered_by`, `escalated_at`, `evidence` JSON). |
| `answer_draft` | Human unsent free-text answer draft keyed by `(run_id, call_id)` (ADR 0061). Survives reloads; deleted on resolve. Never enters the ledger. |
| `product_tool_call` | Idempotency & audit ledger for mutating product tools (`(run_id, call_id)` PK, `tool_name`, `input_hash`, `status`, `result`, `error`). Read-only tools never write here. |
| `agent_run_event` | Run telemetry whitelist (`seq` autoinc, `run_id` FK `CASCADE`, `type`, `data` JSON, `ts`). Streaming text/thinking deltas and `heartbeat` are never persisted. |

### Workflow Orchestration (4 tables)

| Table | Purpose & Key Semantics |
|---|---|
| `workflow_execution` | One run of a `WorkflowDefinition` snapshot (`execution_id`, `workflow_id`, `triggered_by`, `definition` JSON, `input` JSON, `store` JSON, `status`, `exit`, `error`, plus ADR 0082 nullable FKs `requirement_id`, `conversation_id`, `project_id` `ON DELETE SET NULL`). |
| `workflow_node_run` | Append-only node execution rows (`seq` autoinc, `execution_id` FK `CASCADE`, `node_id`, `run_id`, `status`: `running \| waiting_human \| completed \| failed \| superseded`, `order`, `output`, frozen `routed_to` JSON). Rework appends new rows and supersedes prior rows. |
| `workflow_execution_event` | Execution event audit stream (`node_started`, `node_completed`, `node_failed`, `store_write`, `human_task_requested`, `rework_requested`, `budget_exhausted`, `execution_terminal`). |
| `workflow_pending_human` | Open human-gate or `#budget` gate prompts keyed by `(execution_id, node_id)`. |

### Cross-Surface Linkage, Proactive, Proposals & System (8 tables)

| Table | Purpose & Key Semantics |
|---|---|
| `artifact` | ADR 0082 metadata & provenance index (`url` PK, `folder`, `filename`, `size`, `mime_type`, `encoding`, `sha256`, nullable FKs `run_id`, `conversation_id`, `requirement_id`, `workflow_execution_id`, `project_id` `ON DELETE SET NULL`, `agent_id`). Raw bytes remain on disk. |
| `coding_terminal` | ADR 0082 persisted Coding terminal layout & linkage (`terminal_id` PK, nullable FKs `project_id`, `workspace_id`, `conversation_id`, `requirement_id` `ON DELETE SET NULL`, `agent_id`, `cwd`, `title`, `kind`: `shell \| oma`). |
| `proposal` | Unapplied agent suggestions (`id`, `kind`: `agent_config \| workflow_definition \| project_creation \| project_update`, `target_id`, `payload` JSON, `status`: `pending \| adopted \| discarded`). |
| `reminder` | One-shot and 5-field cron nudges (`id`, `conversation_id` FK `CASCADE`, `created_by`, `recurrence`, `text`, `fire_at`, `fired_at`). |
| `proactive_event` | Append-only ambient rule & semantic assessment audit log (`id`, `ts`, `agent_id`, `conversation_id`, `rule_id`, `mode`: `record \| act \| assessment`, `outcome`, `chat_id`, `sender_member_id`, `snippet`). Intentionally has no FK to `conversation` so audit facts outlive deleted rooms. |
| `lark_setup_session` | Persisted Lark setup wizard sessions (`setup_id`, `agent_id`, `profile_ref`, `brand`, `status`: `pending \| completed \| failed \| expired \| cancelled`, `url`, `expires_at`). Tombstones retained for 24h so UI explains expired links. |
| `surface_health` | Per-`(agent_id, surface)` heartbeat and status snapshot (`status`, `last_seen_at`, `payload`, `last_error`). |
| `settings` | Global JSON KV store (`key`, `value`, `updated_at`): auth password hash (`auth.password_hash`), encrypted provider credentials (`provider.*`, `providerEnv`), `proactiveAssessment`, `cost.dailyBudgetUsd`, `workflow.trigger_token.*`. |

## Critical Unique Indexes & Idempotency Keys

| Constraint / Index | Enforced Rule |
|---|---|
| `idx_agent_run_active_branch` (partial unique on `agent_run(branch_id)` `WHERE status IN ('running','waiting','commit_failed')`) | At most **one** active Run per context branch at the database layer. |
| `idx_ledger_agent_run_message` (partial unique on `conversation_ledger(agent_run_id, message_index)` `WHERE agent_run_id IS NOT NULL`) | Terminal commit of a multi-message Run is strictly idempotent across retries and restarts. |
| `idx_context_branch_default` (partial unique on `agent_context_branch(tree_id)` `WHERE is_default = 1`) | Exactly one default branch per context tree. |
| `idx_context_tree_conversation_agent` (unique on `agent_context_tree(conversation_id, agent_id)`) | One context tree per `(conversation, member agent)`. |
| `idx_agent_run_idempotency` (unique on `agent_run(idempotency_key)`) | Deduplicates Run creation (`<input_key>:run`). |
| `idx_queue_input_idem` (`(branch_id, input_idempotency_key)`) & `idx_queue_delivery_idem` (`delivery_idempotency_key`) | Deduplicates enqueued inputs and delivery attempts (`<input_key>:delivery`). |
| `idx_pending_action_response_idem` (unique on `pending_action(response_idempotency_key)`) | Deduplicates human/agent HITL resolutions. |
| `product_tool_call` PK `(run_id, call_id)` + `input_hash` | Replay returns stored result; same key with different input hash fails loudly. |

## Transaction Boundaries

- **Atomic `enqueueAndAcquire`** (`adapter-sqlite-enqueue.ts`): single immediate transaction covering queue insert, active-run guard, branch revision CAS, latest-20 ledger sync into `agent_context_entry`, cursor/leaf update, and `agent_run` creation.
- **Atomic `commitCompletedRun`** (`adapter-sqlite-runs.ts`): single transaction covering canonical message inserts (`ON CONFLICT DO NOTHING`), `agent_context_entry` deduped appends, single branch CAS (`leaf_entry_id`, `ledger_cursor`, `revision + 1`), and `agent_run` status CAS to `completed`.
- **Intentionally NOT in one transaction:** Human message persistence (`conversation_ledger`) completes **before** `enqueueAndAcquire`. A failure between them leaves the human message safely recorded with no Run attached.

## What Deliberately Lives Outside SQLite

| Asset | Storage Location | Truth Relationship |
|---|---|---|
| Agent config & identity | `<workspace>/{agent.yml,SOUL.md,USER.md}` | Files are truth; `agents.config` is a cache. |
| Shared Wiki | `<dataDir>/wiki/` (Git repository) | Markdown files + Git history are truth; no SQLite tables (ADR 0078 removed `knowledge_pack`). |
| Artifact bytes | `<dataDir>/artifacts/<folder>/<filename>` (+ `.meta.json`) | Bytes on disk; `artifact` table is the query/linkage index. |
| MCP server catalog | `<dataDir>/mcp-servers.json` (AES-256-GCM encrypted secrets) | File is truth; per-agent toggles live in `agent.yml`. |
| Workflow definitions | `<dataDir>/workflows/*.workflow.json` | JSON files are truth; executions snapshot the definition JSON at start time. |
| Encryption keys & gateway secrets | `~/.oma/gateway-secrets.json` (`0600`) | Stored outside `dataDir` so DB backups do not leak decryption keys. |

## See also

- [DB Type-Safe Rules](./db-typesafe-rules.md) — Type derivation from `schema.ts` and migration workflow
- [Conversation & Context](./conversation-and-context.md) — Semantics of ledger, members, trees, and branches
- [Agent Run Execution](./agent-run-execution.md) — Queue, HITL, and settlement state machines
- [Workflow Engine](./workflow.md) — Workflow execution tables and `artifacts://` provenance
