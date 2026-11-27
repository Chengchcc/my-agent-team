---
title: Workspaces & Projects
description: Agent workspace layout and config, Workspace Bridge reconciliation, AES-256-GCM MCP catalog, Git mirrors and dual-axis worktrees, safe project_push, workspace locks, and Coding PTY terminals
tags: [workspaces, projects, worktrees, mcp, coding]
---

# Workspaces & Projects

Agent configuration, identity, skills, MCP endpoints, and Git repositories live as ordinary files on disk reconciled by Product Backend. This document specifies workspace layout, Workspace Bridge, the encrypted MCP catalog, Git mirrors & worktrees (agent, requirement, and task axes), safe branch pushing, workspace locks, and browser Coding PTY terminals.

## Authoritative files

- `apps/backend/src/features/agent/workspace.ts` — Workspace seeding (`seedAgentWorkspace`, `CONFIG_DIRS`)
- `apps/backend/src/features/agent/agent-config.ts` — `agent.yml` Zod schema (`agentConfigSchema`, `DEFAULT_HARNESS = "oma"`)
- `apps/backend/src/features/agent/agent-identity.ts` — `SOUL.md` / `USER.md` reader (`identityTextOf`)
- `apps/backend/src/features/agent/workspace-bridge.ts` — `reconcileAgentResources`, `extractMcpSecrets`, `writeMcpConfig`, `writeProductToolsManifest`, `bridgeWorktreeRoot`
- `apps/backend/src/features/mcp/adapter-file.ts` & `apps/backend/src/infra/mcp-secrets.ts` — `<dataDir>/mcp-servers.json` and AES-256-GCM encryption
- `apps/backend/src/features/project/worktree.ts` & `worktree-ops.ts` — Bare mirrors, agent/task worktrees, diff/FF/merge
- `apps/backend/src/features/project/requirement-workspace.ts` & `apps/backend/src/features/workspace/service.ts` — Requirement-owned checkouts (`req/<requirementId>`)
- `apps/backend/src/features/project/push.ts` — Safe worker push (`agent/<runId>`)
- `apps/backend/src/features/project/workspace-lock.ts` — Per-root promise-chain mutex
- `apps/backend/src/features/coding/terminal-registry.ts` & `task-worktrees.ts` & `adapter-sqlite.ts` & `http.ts` — `bun-pty` registry, worktree whitelist, `coding_terminal` table, `/ws/coding/:id`

## Agent Workspace Layout & Config

`seedAgentWorkspace()` creates default files **only when absent** (never overwrites operator edits):

```text
<agentWorkspace>/
  agent.yml               # Primary source of truth (agents.config in SQLite is a cache)
  SOUL.md                 # Persona (placeholder text ignored by identityTextOf())
  USER.md                 # Operator context (optional)
  AGENTS.md / CLAUDE.md   # Workspace instructions
  manifest.json           # {"version": 1}
  .mcp.json               # Written by Workspace Bridge (secret-free ${MCP_SECRET_*} refs)
  .oma/
    product-tools.json    # Written by Workspace Bridge
    skills/<packId>       # Symlinks maintained by Workspace Bridge
    memory/               # MEMORY.md, memory_summary.md, product.md, facts/*.md, memory.db
  .claude/                # settings.json + skills/<packId>
  .pi/skills/<packId>
  .omp/skills/<packId>
  projects/
    <projectId>           # Agent main worktree (branch agent/<agentId>/<projectId>)
    <projectId>.<slug>    # Task worktree (branch agent/<agentId>/<projectId>.<slug>)
```

- **`agent.yml` (`schema_version: "1"`):** defines `enabled`, `id`, `name`, `title`, `description`, `skills[]`, `role` (`front | worker`), `runtime_config` (`harness`, `model`, `reasoning_effort`, `permission_mode`, `deny_write_paths`, `allow_write_paths`, `deny_commands`, `max_steps`, `mcp_servers[]`, `projects[]`), and `lark` (`enabled`, `app_id`, `bot_display_name`, `allowed_senders`, `group_policy`, `groups`, `require_mention`, `respond_to_mention_all`, `ambient.rules[]`, `policy_rev`, `profile_ref`, `web_url`).
- **Workspace viewer security:** `GET /api/agents/:id/workspace/{entries,file}` checks realpaths against `[realRoot, ...extraReadRoots]`, blocks `.mcp.json` with `403`, and caps file reads at `256_000` bytes. `purgeWorkspace()` rejects symlinks and realpath escapes.

## Workspace Bridge (`workspace-bridge.ts`)

Before every Run spawn (and on agent create/update), `reconcileAgentResources()` idempotently projects DB/file truth into workspace config files:

1. **Secret extraction (`extractMcpSecrets`):** replaces every non-empty plaintext value in MCP `env`/`headers` with `${MCP_SECRET_<SERVER>_(ENV|HDR)_<KEY>}` (≤64 chars) so `.mcp.json` on disk **never contains plaintext secrets**. Extracted values ride spawn env alongside `OMA_MCP_EXPANDABLE_VARS`.
2. **`.mcp.json` (`writeMcpConfig`):** writes schema-compliant server entries (emitting `bearerTokenEnv`, `bearer_token_env_var`, and `Authorization: Bearer ${VAR}` fallback) into `[workspacePath, ...extraRoots]`.
3. **`.oma/product-tools.json` (`writeProductToolsManifest`):** writes the Run's product-tool descriptors into `[workspacePath, ...extraRoots]`.
4. **Skill symlinks (`reconcileSkillLinks`):** maintains `<workspace>/{.oma,.pi,.omp,.claude}/skills/<packId>` symlinks on `workspacePath` only; removes stale links, never clobbers real directories.
5. **`.claude/settings.json` (`writeClaudeSettings`):** allows only `history_{recent,search,around,retain}` by default.
6. **Extra worktree bridge (`bridgeWorktreeRoot`):** writes `.mcp.json` and `.oma/product-tools.json` only (never touches main workspace skill links).

## MCP Catalog & Encryption at Rest (`features/mcp/`, `infra/mcp-secrets.ts`)

- Stored in `<dataDir>/mcp-servers.json` (no DB table); per-agent toggles live in `agent.yml`.
- Secret values in `env` and `headers` are encrypted at rest with **AES-256-GCM** (`enc:v1:<b64(12B iv)>:<b64(tag)>:<b64(ct)>`). The 32-byte key (`mcpEncryptionKey`) lives in `~/.oma/gateway-secrets.json` (`0600`, outside `dataDir`).
- Legacy plaintext entries auto-migrate to encrypted form on first read. Wrong key or malformed ciphertext throws loudly (fail-closed).
- All HTTP read endpoints (`GET/POST/PUT /api/mcp-servers*`) mask `env` and `headers` (`"****" + last4` or `"****"`). Only internal `listForAgent`/`requireServer` decrypt plaintext for `extractMcpSecrets`.

## Projects, Bare Mirrors & Three Worktree Axes

Every registered `project` (`project` table; `repoUrl` rejects leading `-` and shell metachars; `delete` returns `409` if attached to any agent or conversation) maintains one shared bare mirror at `<dataDir>/projects/<projectId>.git` (cloned via atomic `.tmp` + `renameSync`; subsequent `ensureMirror` fetches only `defaultBranch:defaultBranch` so local agent branches are never clobbered). All worktrees add `.mcp.json` and `.oma/` to the mirror's `info/exclude`.

| Worktree Axis | Path on Disk | Branch Name | Owner / Lifecycle |
|---|---|---|---|
| **Requirement worktree** (ADR 0077, primary for worker Runs) | `<dataDir>/workspaces/<requirementId>/<projectId>` | `req/<safeRequirementId>` (≤60 chars) | Owned by `requirement` (`workspace` + `requirement_workspace` tables). Serialized across Runs via `workspaceLocks` (`shared: true`). |
| **Agent main worktree** | `<agentWorkspace>/projects/<projectId>` | `agent/<agentId>/<projectId>` | Materialized on demand for Coding terminals and legacy worktree ops (`diff` / `fast-forward` / `merge`). |
| **Task worktree** | `<agentWorkspace>/projects/<projectId>.<slug>` (`TASK_SLUG_RE`: `/^[a-z0-9][a-z0-9-]{0,39}$/`) | `agent/<agentId>/<projectId>.<slug>` | Explicit Coding parallel branches. Removal without `force: true` refuses dirty trees, unmerged commits, or running Coding terminals (`409`). |

- **Worktree ops (`worktree-ops.ts`, HTTP `/api/projects/:id/worktrees/:agentId/{diff,fast-forward,merge}`):** run directly in the bare mirror; require the agent to be attached (`409`); `merge` uses `git merge-tree --write-tree` and refuses two-sided divergence (`409`); `push: true` rolls back `branch -f` if remote push fails.
- **Safe worker push (`project/push.ts`, product tool `project_push`, ADR 0076):**
  - Strictly pushes to `agent/<sanitizedRunId.slice(0, 60)>` (explicitly refuses `agent/master` and `agent/main`).
  - Stages dirty files and commits with `--no-verify` (bypasses untrusted repo hooks); requires ≥1 commit ahead of default branch.
  - HTTPS remotes require `PROJECT_PUSH_TOKEN` and host match against `["github.com", "gitlab.com", "bitbucket.org"]` (or subdomain). Passes token via `-c http.extraHeader=AUTHORIZATION: Basic ...` (never embedded in remote URL) and redacts raw/encoded/base64 token from all errors.
- **Workspace lock (`project/workspace-lock.ts`):** per-canonical-path (`realpathSync`) promise-chain mutex. Failed holders never poison subsequent waiters; logs a warning if a waiter exceeds `30_000 ms` (e.g., holder parked on HITL).

## Coding PTY Terminals (`features/coding/`)

- **Process ownership (`terminal-registry.ts`):** real `bun-pty` (`xterm-256color`, default `80x24`, clamped `2..500 × 2..300`, `400_000`-char scrollback ring buffer) owned by the backend process.
- **Secret stripping:** strips `BACKEND_AUTH_TOKEN`, `PROJECT_PUSH_TOKEN`, `MOCK_PASSWORD`, `MCP_ENCRYPTION_KEY`, `LARK_APP_SECRET`, `LARK_ENCRYPT_KEY`, and `LARK_VERIFICATION_TOKEN` from PTY env.
- **Target resolution (`bootstrap/features.ts`, `task-worktrees.ts`):**
  - `projectId: null` (ADR 0073) opens directly in `agent.workspacePath` (no project binding required).
  - Non-null `projectId` requires agent attachment (`409`) and validates `worktreePath` strictly against main or task worktrees (`422` otherwise).
  - `launch-oma` sends `<omaLaunch>\n` and flips `kind = "oma"`; `GET /api/coding/terminals` overlays live `agentState` from `readAgentStatusFor(cwd)`.
- **Persistence & WS protocol:** layout & ADR 0082 linkage (`project_id`, `workspace_id`, `conversation_id`, `requirement_id`) persist in SQLite `coding_terminal`; boot respawns shells (`oma` panes respawn with `oma --continue; exec /bin/bash`). `WS /ws/coding/:id?ticket=<hex>` validates a 60s single-use ticket (`4001` invalid, `4404` missing), replays `{ t: "o", d }` + `{ t: "s", status, exitCode }`, accepts `{ t: "i", d }` and `{ t: "r", cols, rows }`, and **detaches without killing the PTY** on socket close.

## See also

- [Security Model](./security-model.md) — Path jail, write-path policies, and OS sandboxing
- [Team Coordination](./team-coordination.md) — `project_push`, `project_propose`, `project_attach`, and proposals
- [Web Surface](./web-surface.md) — Browser xterm.js terminal panes and `?locate=1` deep linking
- [Data Model](./data-model.md) — `workspace`, `requirement_workspace`, `coding_terminal` tables
