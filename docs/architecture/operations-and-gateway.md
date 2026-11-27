---
title: Operations & Gateway
description: Backend composition-root DI, oma gateway artifact packaging/lifecycle/upgrade (~/.oma/gateway vs gateway-data), systemd unit templates, OMA_DEBUG=1 stage traces, and symptom-to-layer troubleshooting runbook
tags: [operations, gateway, di, troubleshooting, systemd]
---

# Operations & Gateway

This document covers how CrewDesk is assembled in-process (composition-root DI), packaged and upgraded for self-hosting (`oma gateway` and `systemd`), and diagnosed when runs, surfaces, or sandboxes misbehave.

## Authoritative files

- `apps/backend/src/main.ts` — Boot sequence and `SIGTERM`/`SIGINT` graceful shutdown
- `apps/backend/src/bootstrap/services.ts` — Process-level infrastructure (`openDb`, `settingsSvc`, `mcpClientManager`, `opsStore`, `larkBotRegistry`)
- `apps/backend/src/bootstrap/features.ts` — Composition root wiring all 22 feature routers, late-bound seams, startup recovery, and `dispose()`
- `apps/oh-my-agent/src/cli/gateway-commands.ts` & `update-command.ts` — `oma gateway <up|down|fetch|status|doctor|passwd>` and `oma update`
- `apps/oh-my-agent/src/core/gateway/artifact.ts` & `manifest.ts` & `supervisor.ts` & `daemon.ts` & `doctor.ts` — Artifact download/SHA-256 verification, manifest placeholder resolution, process supervision, diagnostics
- `apps/oh-my-agent/src/core/update/release.ts` — npm dist-tag checks (`latest`, `rc`) and install-owner detection
- `scripts/pack-gateway.sh`, `scripts/install-systemd.sh`, `scripts/lark-bot-unit.sh` — Release tarball builder and systemd installer
- `deploy/systemd/backend.service.template` & `web.service.template` & `lark-bot@.service.template` — Parameterized systemd unit templates

## Composition-Root DI & Startup/Shutdown Order

Product Backend uses **plain factory DI with no DI container**. Every feature follows the same module shape: `domain.ts` (pure types) → `ports.ts` (storage interface) → `service.ts` (`createXxxService(deps)`) → `adapter-sqlite.ts` (Drizzle) → `http.ts` (Elysia plugin) → `index.ts` (barrel). Feature routes never instantiate collaborators.

**Boot order (`main.ts`):**
1. `loadConfig()` → warns if non-loopback `BACKEND_HOST` uses default `"dev-token"`.
2. `createBackendServices(config)` (`bootstrap/services.ts`): opens `backend.db` + runs Drizzle migrations, builds `settingsSvc`, `mcpClientManager` (`allowPrivateHosts` = true only on loopback), `opsStore`, and `larkBotRegistry`.
3. `installFeatures(services)` (`bootstrap/features.ts`): constructs all 22 feature domains, seeds builtin role-scoped skill packs, seeds default agents (`default`, `coder`, `researcher`) and `SOUL.md` templates (only when absent), backfills `artifact` index, and wires late-bound holders (`dispatchRun`, `injectSteer`, `onSessionBound`, `onContinuityRecorded`, `onMessagesUndone`) to break circular references between `conversation`, `agent-run`, `ahp`, and `proactive`.
4. `createApp(token, featureSet)` + `server.start()` — begins serving HTTP/WS.
5. `installed.start()` — runs startup recovery in **strict order**:
   1. `agentRunExecution.recover()` (settles `delivering`, `commit_failed`, orphaned live runs, and unnotified worker results FIRST so branches are clean).
   2. `workflowExecutionService.recover()` (resumes `running` workflow executions without colliding on occupied branches).
   3. Starts reminder 30s tick, workflow human-timeout 30s tick, workflow cron `fs.watch`, Coding terminal restore, and Lark bot supervisor sync.

**Graceful shutdown (`SIGTERM` / `SIGINT`):**
1. `setBackendShuttingDown(true)` **first** so child deaths settle as `aborted`, not `failed`.
2. `server.stop()` → `installed.dispose()` (disposes ACP backends with 3s `SIGTERM`→`SIGKILL` grace, drains in-flight dispatches, clears timers; systemd Lark units stay alive) → `mcpClientManager.disconnectAll()` → `db.close()`.

## `oma gateway` Packaging, Layout & Upgrade

Self-hosted installs keep immutable binaries separate from mutable data so upgrades never touch user state:

```text
$OMA_HOME/ (default ~/.oma/)
  gateway/
    versions/<version>/     # Unpacked oma-gateway-<v>.tar.zst (atomic + .complete marker)
      gateway.json          # schemaVersion: 1, component commands, health URLs, dependsOn
      backend/main.js       # Bundled backend + drizzle/ + bun-pty + resources/{skills,workflow-showcase}
      web/                  # Next.js standalone build + .next/static + public/monaco/vs
    current -> versions/<v>
    up.pid / up.log (0600)  # Detached daemon tracking
  gateway-data/             # Persistent backend.db, workspaces/, wiki/, artifacts/, workflows/
  gateway-secrets.json      # 0600: BACKEND_AUTH_TOKEN, MOCK_PASSWORD, mcpEncryptionKey, etc.
  models.yml                # Hardened model/provider catalog (OMA_WORKSPACE_CATALOG=0)
```

- **Packaging (`scripts/pack-gateway.sh`):** emits `oma-gateway-<version>.tar.zst` + `SHA256SUMS`. `oma gateway fetch` verifies SHA-256 (`60 s` stall timeout; default GitHub repo `Chengchcc/crewdesk`, overridable via `OMA_GATEWAY_REPO` / `OMA_GATEWAY_BASE_URL`).
- **Supervision (`supervisor.ts`, `daemon.ts`):** resolves `{root}`, `{dataDir}`, `{omaBin}`, `{secret:NAME}` placeholders in `gateway.json` (unknown placeholders throw), starts components in `dependsOn` order gated on health checks, and stops in reverse order (`SIGTERM` → 5s → `SIGKILL`). `oma gateway up -d` polls web health up to `60 s`; `oma gateway down` verifies `/proc/<pid>/cmdline` (or `ps`) contains `"gateway up"` before signaling (`10 s` grace → `SIGKILL`).
- **Password rotation (`oma gateway passwd`):** generates a random password, updates `gateway-secrets.json`, pushes via `PUT /api/auth/password` if running, or drops `PASSWORD_RESET_MARKER` in `gateway-data/backend/` for next boot.
- **Upgrade (`oma update [--check] [--version]`):** checks npm `latest` / `rc` dist-tags (`5 s` timeout; refuses silent downgrade unless `--version` pinned), fetches gateway artifact, runs `bun add -g` **only** when `detectInstallOwner()` confirms `bun-global` (skips source checkouts), and restarts a running detached gateway if on an older version.

## Systemd Deployment (`scripts/install-systemd.sh`, `deploy/systemd/`)

Renders `@REPO_DIR@`, `@RUN_USER@`, `@RUN_HOME@`, `@BUN_BIN@`, `@BUN_DIR@`, `@UNIT_PREFIX@` (default `my-agent-team`), and `@WEB_MEMORY_MAX@` (default `3400M`) into `/etc/systemd/system/`:
- `my-agent-team-backend.service` & `my-agent-team-web.service` — enabled and restarted.
- `my-agent-team-lark-bot@.service` — template left disabled; Product Backend spawns/stops per-PA instances (`my-agent-team-lark-bot@<safeAgentId>.service`) via `LARK_BOT_SUPERVISOR=systemd` + `scripts/lark-bot-unit.sh` reading `0600` `<dataDir>/lark-bot/<safeAgentId>.env`.

*(Note on Next.js + Bun: `next`'s bin has `#!/usr/bin/env node`, so `bun run` launches Next under Node; invoke `bun node_modules/next/dist/bin/next start` explicitly to run on Bun. On 2-core / 8 GB boxes, wrap `next build` in `bash scripts/memguard.sh --limit <free>G -- ...`.)*

## Troubleshooting Runbook

Enable verbose stage tracing with `OMA_DEBUG=1` (logs all 9 dispatch stages in `execution-dispatch.ts` and ACP lifecycle to stderr), and run `oma gateway doctor` for quick environment/secret/port checks.

| Symptom | First Layer to Check | Concrete Inspection / Fix |
|---|---|---|
| **Message posted, no Run starts** | Conversation routing / Queue | Check `GET /api/conversations/:id/members` (>1 member requires mention unless room fallback), `GET /api/tasks` (branch occupied by `running` / `waiting` / `commit_failed` Run), or `422` at `model_preflight`. |
| **Run fails immediately with 422 / unknown model** | ACP harness catalog | Check `GET /api/models/readiness` and `GET /api/harnesses`. Missing CLI (`oma`/`claude`/`pi`/`omp`) on `PATH` or missing provider key yields empty catalog. |
| **Branch stuck permanently after DB error** | `commit_failed` Run | Query `GET /api/agent-runs?status=commit_failed`. No runtime retry HTTP exists yet; restarting backend invokes `recover()` to retry `commitCompletedRun` from saved `terminal_result`. |
| **Run stuck in `waiting` with no card in UI** | Durable HITL (`pending_action`) | Check `GET /api/pending-actions` and `GET /api/attention`. Resolve via `POST /api/agent-runs/:runId/approval` or `/api/product-tools/ask/resolve`, or cancel via `/cancel`. |
| **Web chat connects then drops with `4001`** | AHP WS ticket / BFF host | Verify `AHP_PUBLIC_WS_BASE` behind reverse proxies; ensure single-use tickets aren't replayed and `SESSION_SECRET` / `BACKEND_AUTH_TOKEN` match between Web and Backend. |
| **Lark bot online in systemd, silent in chat** | Inbound policy / Heartbeat | Inspect `GET /api/agents/:id/lark` (`LarkSurfaceView` issues), verify `allowed_senders` (empty denies all), group `group_policy` + `@mention`, and `<stateRoot>/lark-bot/<agent>/bindings.sqlite`. |
| **Workflow script node fails immediately** | Sandbox gate | Script nodes require `WORKFLOW_SCRIPTS_ENABLED=1` and working `bwrap` (Linux) or `sandbox-exec` (macOS). Check `GET /api/workflow-definitions` (`scriptNodesBlocked`). |
| **Agent cannot see newly edited `agent.yml`** | Cached `agents.config` | Edit via API/UI (`PATCH /api/agents/:id`) rather than hand-editing `agent.yml` alone; in-flight Runs keep their frozen snapshot by design. |
| **Forgot Web login password** | `settings["auth.password_hash"]` | Run `oma gateway passwd` (gateway install) or `bash scripts/reset-login-password.sh` + restart backend (source install). |

## See also

- [System Overview](./system-overview.md) — Container topology and execution pipeline
- [Agent Run Execution](./agent-run-execution.md) — `recover()` steps and watchdogs
- [Security Model](./security-model.md) — `gateway-secrets.json`, auth exemptions, and sandboxes
