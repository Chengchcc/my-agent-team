---
title: Security Model
description: Single-operator threat model, four orthogonal security boundaries (entry auth, workspace/config freeze, oma kernel defenses, OS process sandboxes), encryption at rest, and living security debt register
tags: [security, sandbox, auth, oma, debt]
---

# Security Model

CrewDesk is designed for a **single-operator, local / self-hosted deployment** (ADR 0026). Web login, BFF, and Product Backend share one operator identity; **there is no multi-tenant isolation** across SQLite tables. Do not expose CrewDesk directly to untrusted multi-user networks without addressing the network-exposure items in the debt register below.

## Authoritative files

- `apps/backend/src/app.ts` & `apps/backend/src/infra/auth.ts` & `apps/backend/src/infra/ws-ticket.ts` — Global `authGuard`, `safeTokenEqual`, one-time WS tickets
- `apps/backend/src/features/auth/password.ts` & `apps/web/src/lib/{auth,session,bff}.ts` — Argon2id login, `maw_session`, BFF auth injection
- `apps/backend/src/infra/mcp-secrets.ts` & `apps/backend/src/infra/allowlist-proxy.ts` — AES-256-GCM secret encryption and cooperative CONNECT proxy
- `apps/oh-my-agent/src/core/tools/workspace-sandbox.ts` — `WorkspaceSandbox` path jail (40-hop symlink + dangling-leaf check)
- `apps/oh-my-agent/src/core/tools/file-tools.ts` & `bash.ts` — `PROTECTED_FILES`, `OMA_{DENY,ALLOW}_WRITE_PATHS`, `deniedCommand`, `writeEscapeOf`
- `apps/oh-my-agent/src/core/runtime/permission-rules.ts` & `apps/oh-my-agent/src/core/settings/project-settings.ts` — Pattern permission rules (`hasShellCompoundSyntax` anti-injection guard) and 3-tier settings trust boundary
- `apps/oh-my-agent/src/core/tools/url-guard.ts` — `assertSafeUrlDeep()` SSRF & cloud-metadata filter
- `apps/oh-my-agent/src/core/tools/bash-sandbox.ts` — `NullBashSandbox`, `BwrapBashSandbox`, `SeatbeltBashSandbox`
- `packages/sandbox/src/index.ts` — `runInSandbox()`, `canSandbox()` for `eval` and workflow `script` nodes

## Four Orthogonal Boundaries

### 1. Entry Auth & Secret Isolation
- **Loopback by default:** Backend (`127.0.0.1:3000`) and Web bind loopback unless overridden. `main.ts` warns loudly if `BACKEND_HOST` is non-loopback while `BACKEND_AUTH_TOKEN === "dev-token"`.
- **Global `authGuard` (`apps/backend/src/app.ts`):** mounted on the root Elysia instance before all `.use()` plugins; compares `x-auth-token` with SHA-256 + `timingSafeEqual` (`safeTokenEqual`).
  - **Exactly 3 exemptions** (none are open except `/health`):
    1. `/health`
    2. `/ws/*` — authenticated per connection via 256-bit one-time `WsTicketRegistry` ticket (`60 s` TTL, `4001` on invalid/reused).
    3. `/api/workflow-triggers/*` — authenticated per workflow via constant-time `x-trigger-token`.
- **Web login & BFF:** browser holds only HMAC-SHA256 `maw_session` (`HttpOnly; SameSite=Lax`). Login verifies against backend argon2id `auth.password_hash` (`MIN_PASSWORD_LENGTH = 8`), rate-limited (`5` failures / `60 s` global lock). `BACKEND_AUTH_TOKEN` is injected server-side by `/api/bff/[...path]`.
- **Encryption at rest:** SQLite DB/WAL/SHM are `0600` (`0700` dataDir). Provider API keys and MCP `env`/`headers` encrypt via **AES-256-GCM** (`enc:v1:<iv>:<tag>:<ct>`) using a 32-byte key stored in `~/.oma/gateway-secrets.json` (`0600`, outside `dataDir`). All HTTP reads mask secrets.

### 2. Config, Role & Workspace Freeze
- **Per-run snapshot freeze:** `systemPrompt`, `skillRoots`, `permissionMode`, `toolPolicy` (`deny`/`allow`/`denyCommands`/`disabledTools`), `authorization`, `parentRunId`, and `risk` freeze at enqueue/acquire time. Mid-run agent edits append `config_changed_during_run` telemetry without mutating the active Run.
- **Model catalog isolation:** product runs set `OMA_WORKSPACE_CATALOG=0` so `oma` reads **only** `$OMA_HOME/models.yml`, preventing an agent run from tampering with `baseUrl` or stealing keys via workspace `.oma/models.yml`.
- **Role & Git boundaries:** `FRONT_DESK_DISABLED_TOOLS` removes all 14 execution/file/web/delegation tools from PA agents; `project_push` only pushes `agent/<runId>` (refuses `main`/`master`, commits with `--no-verify`, passes `PROJECT_PUSH_TOKEN` via `http.extraHeader` only to allowlisted Git hosts); `agent-config` MCP refuses `permissionMode: "yolo"` and write/command policy overrides.
- **Spawn env filtering:** `buildAcpSpawnEnv()` and `TerminalRegistry` strip `BACKEND_AUTH_TOKEN`, `PROJECT_PUSH_TOKEN`, `MOCK_PASSWORD`, `MCP_ENCRYPTION_KEY`, and `LARK_*` secrets before launching child processes.

### 3. `oma` In-Process Kernel Defenses
- **Path jail (`workspace-sandbox.ts`):** canonicalizes root via `realpathSync`; `validate()` and `validateNew()` walk every path segment with `lstatSync` up to `MAX_SYMLINK_HOPS = 40`, resolving both live symlinks and **dangling leaf symlinks** to block symlink-creation escapes.
- **Protected files & write policy (`file-tools.ts`):** blocks `write`/`edit` on `.mcp.json`, `mcp.json`, `.oma/settings.json`, `.oma/settings.local.json`, `.claude/settings.json`, `.claude/settings.local.json`, and direct `.oma/*.json` children. Enforces `OMA_DENY_WRITE_PATHS` (checked first) and `OMA_ALLOW_WRITE_PATHS` at the tool layer even in `yolo`.
- **Shell tripwires & bash allow-rule guard (`bash.ts`, `permission-rules.ts`):** `deniedCommand()` matches exact trimmed commands and segments split on `&&`, `||`, `;`, `|`, `\n` (advisory tripwire, not adversarial isolation); `writeEscapeOf` parses quotes and segments to block redirects and write commands targeting outside the workspace. Standalone `bash:<pattern>` permission allow-rules reject commands containing unquoted shell chaining, redirection, or command substitution (`hasShellCompoundSyntax`) unless the rule explicitly includes it, while `deny` rules still match compound commands (fail-closed).
- **URL / SSRF guard (`url-guard.ts`):** restricts to `http:`/`https:`, runs DNS `lookup({ all: true, verbatim: true })` on the initial URL and every redirect hop (max 5, 10s timeout), and blocks loopback, RFC1918, CGNAT (`100.64/10`), link-local/cloud metadata (`169.254/16`, `metadata.google.internal`, `instance-data`), IPv6 ULA/link-local, and embedded IPv4-in-IPv6 forms. `isMetadataHost()` stays blocked even when `OMA_BROWSER_LOCAL_NETWORK=1` or `allowlist-proxy` uses `"*"`.
- **Plugin, MCP & settings trust:** project plugins, standalone `.mcp.json`, and workspace settings (`.oma/settings.json`, `.oma/settings.local.json`) require SHA-256 approval in `<agentDir>/trusted-plugins.json`. Untrusted workspace settings downgrade `yolo` → `ask` and strip `browserLocalNetwork: true` and `permissions.allow` (always honoring `permissions.deny`); writing a benign key into a previously untrusted settings file strips pre-existing untrusted weakening keys before trusting. Project plugins never load in `acp`/`rpc` mode; `permissionMode: "deny"` skips `import()` entirely.

### 4. OS Process Sandboxes & Cooperative Network Allowlist
- **`packages/sandbox` (`eval` & workflow `script` nodes):** minimal env (`PATH`, `HOME=tmpdir()`, `LANG`), `10 MiB` output cap, default `30 s` timeout (`60 s` for workflow scripts), process-group `SIGTERM` → 2s → `SIGKILL`. On Linux uses `bwrap --ro-bind / / --dev /dev --tmpfs /tmp --die-with-parent --unshare-pid --proc /proc [--unshare-net] --tmpfs /root --tmpfs /home` plus `denyReadDirs` masking (`dataDir`, `.env`); on macOS uses `sandbox-exec`. Workflow scripts are **off by default** (`WORKFLOW_SCRIPTS_ENABLED=1` required).
- **`bash-sandbox.ts` (`oma` `bash` tool):**
  - `enabled=false` → `NullBashSandbox` (`bash -c`, detached for TTY isolation).
  - Linux (`enabled=true`) → `BwrapBashSandbox` (fails closed if `bwrap` missing; `--ro-bind / / --unshare-pid --proc /proc --unshare-net --tmpfs /tmp --tmpfs /root --tmpfs /home --bind <ws> <ws>`, re-binds `.mcp.json`, `.oma/plugins.json`, `.oma/settings.json`, `.oma/settings.local.json` read-only, masks `OMA_DENY_WRITE_PATHS`).
  - macOS (`enabled=true`) → `SeatbeltBashSandbox` (fails closed if `sandbox-exec` missing; `(deny default)`, writes allowed only inside realpath `{WORKSPACE}`, `/private/tmp`, and `/dev/{null,zero,stdout,stderr,tty,fd}`; `(deny network*)`).
  - `yolo` mode force-enables OS bash sandboxing whenever available.
- **Cooperative network allowlist (`infra/allowlist-proxy.ts`):** loopback HTTP/HTTPS `CONNECT` proxy matching exact/subdomain labels (always blocks `isMetadataHost` with `403`). **Advisory only:** scripts that ignore `HTTP(S)_PROXY` bypass it; hard egress filtering requires privileged OS firewalling (`nftables`).

## Living Security Debt Register (Verified Against Code)

### Closed / Hardened
- DB/WAL/SHM `0600` & dataDir `0700`; provider keys & MCP `env`/`headers` AES-256-GCM encrypted at rest with key outside `dataDir`.
- `bwrap` PID namespace isolation (`--unshare-pid --proc /proc`) implemented in both `packages/sandbox` and `bash-sandbox.ts`.
- MCP URL SSRF guard & secret masking on all read routes; `agent-config` MCP blocks `yolo` self-escalation; `deniedCommand` splits shell operators.

### Open Accepted Debt (Single-Operator Scope)

| Area | Current Gap / Residual Risk |
|---|---|
| **MCP stdio CRUD** | Any holder of `BACKEND_AUTH_TOKEN` can register arbitrary `command`/`args`/`env` (host RCE; accepted under single-operator model). |
| **Path jail & Seatbelt** | `WorkspaceSandbox` is check-then-use (TOCTOU / hardlinks); macOS `SeatbeltBashSandbox` writes its temp profile inside agent-writable `<ws>/.oma/`. |
| **Session & Queue routes** | `cliSessionRef` is not path-validated before joining in `oma`; `GET /api/conversations/:id/inputs` ignores the `:id` path parameter when reading by branch; `/entries` does not realpath symlinked directories. |
| **Workflow & Local MCP** | Human-task answers bypass `outputSchema`/form metadata validation; JSON-Logic `pathGet` walks the JS prototype chain; workflow execution listing & batch human-task resolve are uncapped; local `agent-config` and `workflow` MCP servers do not mandate bearer auth by default on `127.0.0.1`. |
| **Web Auth & BFF** | Login rate-limit is a single global bucket ignoring `X-Forwarded-For`; BFF path normalization allows `%2e%2e` prefix escape (only `/health` exists outside `/api/`); `/api/auth/logout` lacks CSRF token; expired sessions on `/api/*` receive middleware `302` instead of `401`. |
| **Lark Bot** | Dev spawner passes `--backend-auth-token` in argv (visible in `ps`; systemd uses `0600` `EnvironmentFile`); HTTP client lacks `401` backoff/redaction. |

## See also

- [Skills & Plugins](./skills-and-plugins.md) — Plugin SHA-256 trust matrix and HITL permission classifier
- [Workspaces & Projects](./workspaces-and-projects.md) — MCP secret extraction and `project_push` guards
- [Operations & Gateway](./operations-and-gateway.md) — `gateway-secrets.json` layout and `oma gateway doctor`
