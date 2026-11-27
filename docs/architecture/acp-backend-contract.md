---
title: ACP Backend Contract
description: The 5-method AgentBackend interface, single acp backend kind, 4 registered CLI harnesses (oma/claude/pi/omp), stdio JSON-RPC lifecycle, spawn env filtering, event mapping, and HeldPermission
tags: [backend, acp, runtime, protocol]
---

# ACP Backend Contract

`AgentBackend` is the sole execution boundary between Product Backend and every coding-agent runtime. There is **one** backend kind (`BACKEND_KINDS = ["acp"]`, ADRs 0039/0040) driving **four** CLI harnesses (`oma`, `claude`, `pi`, `omp`) through one stdio JSON-RPC Agent Client Protocol (ACP) client (`AcpBackend`).

## Authoritative files

- `apps/backend/src/features/agent-run/protocol/kinds.ts` — `BACKEND_KINDS = ["acp"]`
- `apps/backend/src/features/agent-run/protocol/backend.ts` — `AgentBackend`, `BackendRegistryEntry`, `BackendRegistry`
- `apps/backend/src/features/agent-run/protocol/run.ts` — `BackendRunInput`, `BackendRunOutcome`, `BackendRunSegment`, `ResumeDecision`
- `apps/backend/src/features/agent-run/protocol/history.ts` — `WorkspaceBinding`, `AgentRunSnapshot`
- `apps/backend/src/features/agent-run/protocol/event.ts` — `CoreBackendEvent`, `BackendExtensionEvent`, `ToolPresentation`
- `apps/backend/src/features/agent-run/protocol/model.ts` — `BackendModelRef`, `REASONING_EFFORTS`
- `apps/backend/src/features/agent-run/acp/registry.ts` — `ACP_AGENTS`, `harnessOf()`, `resolveAcpAgentKey()`
- `apps/backend/src/features/agent-run/acp/acp-backend.ts` — `AcpBackend`, `AcpBackendError`, `writeAllowList()`
- `apps/backend/src/features/agent-run/acp/transport.ts` — `createNodeSpawn()`, `buildAcpSpawnEnv()`, `ACP_EXTRA_FORWARDED_KEYS`
- `apps/backend/src/features/agent-run/acp/event-mapping.ts` — `createAcpAccumulator()`, `mapAcpUpdate()`, `mapOmaUpdate()`, `buildOutcomeMessages()`
- `apps/backend/src/features/agent-run/acp/harness-catalog.ts` — Live harness model probing via `session/new`
- `apps/backend/src/features/agent-run/acp/shutdown.ts` — `setBackendShuttingDown()` / `isBackendShuttingDown()`
- `apps/oh-my-agent/src/modes/acp/acp-mode.ts` — `oma`'s ACP server implementation
- `apps/oh-my-agent/src/protocol/mapping.ts` — Child-side extension event mapping (parity locked by `mapping.test.ts`)

## The 5-Method `AgentBackend` Contract

| Method / Property | Contract |
|---|---|
| `kind` | Literal `"acp"`. Harness routing lives in `modelRef.harness` (fallback `modelRef.modelId`). |
| `execute(input)` | Spawns one ephemeral child and returns `BackendRunSegment { events, outcome, stop() }`. Same `runId` + identical payload is idempotent; different payload throws `AcpBackendError("conflict")`. |
| `steer(runId, input)` | Sends `_session/steering` (`{ sessionId, prompt }`) into a **live** Run only when the harness advertised `_meta.steering.supported === true`. Fails explicitly when not live or unsupported — never silently queues. |
| `resolveApproval?(runId, callId, decision)` | Resolves a held `session/request_permission` promise (`allow \| allow_always \| deny \| deny_always`). Its presence on the backend entry gates `POST /api/agent-runs/:runId/approval`. |
| `stop(runId)` | Cancels the active Run; `outcome` resolves to `{ status: "aborted" }`. |
| `dispose()` | Rejects new `execute` calls, sends `SIGTERM` → `abortGraceMs` (3s) → `SIGKILL` to all children, and waits for process exit. |

There is no `abort()` method and no cross-run session handle on the contract.

## Harness Registry (`ACP_AGENTS`)

`resolveAcpAgentKey()` strips an optional `acp/` prefix and throws on unknown keys — **never** falls back to another harness:

| Harness Key | Spawn Command | Required Binary |
|---|---|---|
| `oma` | `oma --mode acp` | `oma` |
| `omp` | `omp acp --approval-mode always-ask` | `omp` |
| `claude` | `npx -y @agentclientprotocol/claude-agent-acp@^0.76.0` | `claude` |
| `pi` | `npx -y pi-acp@^0.0.33` | `pi` |

Model capabilities (including vision/multimodal support and provider credentials) are owned by each harness CLI's own config (`~/.oma/models.yml`, `~/.claude/settings.json`, etc.). Sending images to a text-only model silently degrades on the provider/harness side; Backend performs no modality probing.

## Spawn Environment Isolation (`acp/transport.ts`, `acp/acp-backend.ts`)

`buildAcpSpawnEnv()` builds a sanitized environment from `@chengchenccc/message`'s `childEnv()` plus `ACP_EXTRA_FORWARDED_KEYS` (locale, `TMPDIR`, TLS CA certs, proxy vars, provider base URLs/API keys, `OMA_CODING_AGENT_DIR`, `OMA_SESSION_DIR`, `OMA_FAKE_PROVIDER`). Backend secrets (`BACKEND_AUTH_TOKEN`, `LARK_APP_SECRET`, `MOCK_PASSWORD`, `MCP_ENCRYPTION_KEY`) are **never** inherited.

Per-Run env vars injected exclusively at spawn (stripped from wire payloads):
- `PRODUCT_TOOLS_RUN_TOKEN` — ephemeral bearer token for Product Tools MCP
- `OMA_MCP_EXPANDABLE_VARS` & extracted `MCP_SECRET_*` (`input.mcpEnv`) — secret-free `.mcp.json` variable expansion
- `OMA_CONSENTED_MCP_TOOLS` — pre-consented product tool names exempt from permission prompts
- `OMA_DENY_WRITE_PATHS`, `OMA_ALLOW_WRITE_PATHS` (always includes `workspace.root/` + `toolPolicy.allow`), `OMA_DENY_COMMANDS`, `OMA_DISABLED_TOOLS`

## ACP Stdio JSON-RPC Lifecycle

```text
spawn harness CLI (stdio ndJsonStream)
  1. initialize                  Inspect _meta.steering.supported and mcpCapabilities.acp
  2. session/load | session/new  Pass _meta["my-agent-team/permissionMode"] and
                                 _meta["my-agent-team/resume"] ({ decisions } or { adopt: "last-interrupted" }).
                                 Mount in-process acpMcpProvider if mcpCapabilities.acp is true.
                                 AWAIT onSessionBound(runId, sessionId) BEFORE prompting (fail = abort run).
  3. session/setConfigOption     If harnessModel is set, require category==="model" in configOptions
                                 and assert currentValue === harnessModel (throw "unsupported" if ignored).
  4. session/prompt              Send multimodal promptBlocksOf(message) (text + base64 images).
  5. sessionUpdate stream        Map standard ACP updates + _oma/update extensions → BackendEvent.
  6. session/request_permission  Emit approval_requested (with deadlineAt + sandboxed), hold promise
                                 with fail-closed timer (DEFAULT_APPROVAL_TIMEOUT_MS = 24h → reject_once).
                                 Inbound elicitation/create always returns { action: "decline" }.
  7. settle & reap               Return BackendRunOutcome; after prompt settles, wait abortGraceMs (3s)
                                 and kill lingering child to prevent leaked ACP processes.
```

If the child connection drops while `isBackendShuttingDown()` is true, `AcpBackend` settles the Run as `aborted` instead of `failed`.

## Inputs, Outcomes & Event Mapping

- **First-turn bridge:** history is **not** part of `BackendRunInput`. When a branch has no matching `cliSessionRef`, `execution-input.ts` flattens the projected branch history into `## Conversation so far` inside `input.message` and appends a Product Context section (`runId`, `conversationId`, `agentId`, `branchId`, current todos, recall hits, interrupted jobs) into `run.systemPrompt`.
- **Outcomes (`BackendRunOutcome`):**
  - `{ status: "completed", messages?, usage?, title?, summary?, cliSessionRef?, workflow? }`
  - `{ status: "failed" | "aborted" | "timeout", error?, usage?, cliSessionRef?, messages? }`
- **Event mapping (`acp/event-mapping.ts`):**
  - `agent_message_chunk` → `text_delta` (+ accumulated text part)
  - `agent_thought_chunk` → `thinking_delta`
  - `tool_call` / `tool_call_update` → `native_tool_started` (`pending | in_progress`) and `native_tool_completed` (`completed | failed`, preserving `isError` and accumulated `tool_call`/`tool_result` parts)
  - `plan` / `plan_removed` → `backend.oma.todo_update` (`plan_update` dropped)
  - `_oma/update` (`mapOmaUpdate`) → `status: "heartbeat"`, `delegation_*`, `mcp_mount_result`, `job_state` (`bash | eval | subagent` × `started | finished | failed | cancelled`)
- **Permission option mapping (`resolveApproval`):** maps `allow` / `allow_always` / `deny` / `deny_always` to agent-declared `optionId`s, degrading `*_always` to `*_once` if the harness did not advertise an always option.

## Harness Catalog Probing (`acp/harness-catalog.ts`)

`probeHarnessCatalog()` (default `timeoutMs = 30_000`) spawns the harness, opens a temporary `session/new`, reads `configOptions` where `category === "model"`, and converts them into `BackendModel[]`. Cached per harness in `features/models/harness-catalog.ts` (`ttlMs = 10 min`, deduplicated in-flight, isolated errors). If a harness CLI is missing from `PATH`, its catalog entry reports an error and runs targeting it fail at `model_preflight` with HTTP 422.

## Invariants

1. `BACKEND_KINDS` contains only `"acp"`; harness CLI flags and bridges never leak into `execution-dispatch.ts`.
2. `onSessionBound(runId, sessionId)` must complete before `session/prompt` runs so parked HITL runs always know their own recovery session.
3. Unknown harness keys or ignored `session/setConfigOption(model)` fail loudly rather than running a silent fallback model or harness.
4. `PRODUCT_TOOLS_RUN_TOKEN` travels only in spawn env, never in JSON-RPC params or workspace files.
5. Every spawned ACP child is explicitly reaped after prompt settlement (`abortGraceMs = 3s`).

## See also

- [Agent Run Execution](./agent-run-execution.md) — How dispatch invokes `AcpBackend` and settles outcomes
- [Oma Runtime](./oma-runtime.md) — `oma --mode acp` server internals
- [Models & Providers](./models-and-providers.md) — Live catalog probing and served-model discovery
- [Backend Kinds Gate 0 Snapshot](./backend-kinds-gate0.md) — Historical (2026-08) pre-ACP CLI measurements
