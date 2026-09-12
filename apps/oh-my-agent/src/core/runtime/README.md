# `core/runtime` — reading order

The agent loop is one behaviour spread over a few files, deliberately: the loop
must not know about products, the runtime must not know about the TUI, and the
assembly must not know about the loop's internals. Read them in this order.

## The loop (pure behaviour, no I/O policy)

| File | What it is |
|---|---|
| `agent-loop-types.ts` | `OmaSession` / `OmaSessionOptions` — the loop's whole contract. **Start here.** |
| `agent-loop.ts` | `createOmaSession()`: wires store + plugins + listeners and exposes `startLoop` / `steer` / `stop`. |
| `agent-loop-runner.ts` | `runLoop()`: the step machine (steer drain, compaction, retries, terminate). The `while (step < maxSteps)` lives here. |
| `agent-loop-run.ts` | One turn's mechanics: `streamModelTurn()` (stream → `ModelTurn`) and `executeTools()` (hooks, permission gate, concurrency). |
| `agent-loop-messages.ts` | `ModelTurn` → persisted entries (assistant/tool batches). Persistence is a turn-level decision, never inside the stream. |
| `agent-event.ts` | `OmaLoopEvent` — every event a surface can observe. |
| `agent-loop-utils.ts` | Small pure helpers (JSON parse of streamed args, stream-rule match). |

Read `agent-loop-types.ts` → `agent-loop.ts` → `agent-loop-runner.ts` → then dip
into `agent-loop-run.ts` when you need tool-execution detail. Note that
`agent-loop.ts` is NOT the loop; it is the factory.

## Assembly (the only place policy is decided)

| File | What it is |
|---|---|
| `run-runtime.ts` | `assembleRunRuntime()`: the ONE place that resolves "what does this Run get". Internally a sequence of named stage builders (same file): `buildNativeToolStage` (tool table + MCP mount + timeout wrap), `buildModelPlumbing` (summarizer / budget / caps), `createRunPermissionGates` (ADR 0020 gates), `createDelegationStack` (subagents + vm scripts + hub plugin). Add a capability by extending a stage, not by growing the orchestration body. |
| `create-runtime.ts` | `createOmaRuntime()`: the per-Run facade the modes use (`run/steer/stop/close` + outcome mapping). `RunRuntimeDeps` extends its options type — shared fields have ONE definition. |
| `runtime-catalog.ts` / `model-catalog.ts` | models.yml loading and the Backend catalog projection. |
| `model-effort.ts` | The single reasoning-effort → provider-options mapping. |
| `tool-filter.ts` / `tool-pruning.ts` | `--tools` filtering; read-side pruning of old tool results (opt-in via settings `prune`). |

## Child-agent subsystems (how they relate)

Three core modules cooperate; the seams are deliberate:

- `delegation/` — the **executor**: spawns subagent loops (role files under
  `.oma/agents/`), enforces caps/budget, and the `delegation-tools` plugin
  (`delegation_batch` fan-out).
- `orchestrate/` — the **script engine**: `evaluateOrchestrationScript` runs a
  vm-sandboxed JS script whose `agent()`/`pipeline()` primitives route INTO the
  delegation executor. The `orchestrate-tool` plugin (and the Run input's
  `workflow` field) are its surfaces.
- `coordination/` — the **handle ledger**: `CoordinationRegistry` tracks
  background jobs and subagent handles per scope; the `hub-tool` plugin is its
  model-facing query/steer/stop surface. The registry outlives a Run only when
  a long-lived surface (TUI) passes its own instance.

 run-runtime's `createDelegationStack` wires the three together; usage
 accounting and the budget gate stay at that call site.

## Supporting policy

| File | What it is |
|---|---|
| `plugin.ts` / `plugin-runtime.ts` | Plugin shape + the capabilities injected into hooks. |
| `permission-classifier.ts` | `permissionMode: "auto"` reviewer (fail-closed). |
| `approval.ts` | HITL approval types + deadline (deny on timeout). |
| `prompts.ts` / `prompt.ts` | System prompt and the per-loop Meta message. |
| `compaction.ts` / `context-estimate.ts` / `message-cache.ts` | When and how context is compacted; token accounting. |
| `retry.ts` / `stream-rules.ts` / `title.ts` | Stream retry policy; TTSR rules; auto-title (opt-in). |
| `loop-input.ts` | Builds the append batch: history + exactly one Meta + the driving input. |
| `process-tree.ts` | Process-group teardown shared by sandboxed children. |
| `fake-provider.ts` | Deterministic provider for tests (`OMA_FAKE_*`). |

## Two traps worth knowing

1. **`sessionId` is `runId`.** oma's SessionStore is per-Run, so
   `createOmaRuntime({ runId })` feeds it as the session id
   (`create-runtime.ts`, `run-runtime.ts`). They are the same value on purpose;
   the durable *conversation* identity belongs to the product backend.
2. **One model stream, three callers.** The loop, the auto-title generator and
   the post-run memory extractor all go through
   `RunRuntimeDeps`-assembled `streamModel`. Tests that count model calls must
   separate them (see `create-runtime-title.test.ts`).
