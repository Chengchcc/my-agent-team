# DESIGN.md

> **Purpose of this document.** This is a *behavioral contract* and *test-coverage map* for the Lobster v2.0 codebase. It is written to guide future agents in performing TDD / BDD on the system. Every section follows the same template:
>
> 1. **Subject** — concrete file(s) / class(es) / function(s) the section describes.
> 2. **Invariants** — properties that must always hold (write these as tests first).
> 3. **Observable signals** — events on the bus, return values, RPC responses, files touched. These are the *only* legal probes for black-box tests.
> 4. **Edge cases / failure modes** — known boundary conditions; each should be a separate test case.
> 5. **Current coverage** — actual `tests/...` files that exercise the subject.
> 6. **Coverage gaps & suggested new tests** — given/when/then or red→green steps for the next round of test work.
>
> Two non-negotiable rules for editors of this document:
>
> - **Code first, then write.** If a behavior is not in `src/`, it does not belong here. Mark un-implemented ideas as *Not implemented — TODO*.
> - **Never describe non-existent test coverage.** The "Current coverage" lines are checked against `tests/` on every audit. Adding a test file is a precondition for promoting a TODO to a real section.

---

## 0. Architecture in one paragraph

Lobster is a long-lived per-agent daemon. The **Kernel** (`src/kernel/`) is a thin DI container: it boots an *extension graph* (`apply()` runs in topological order over `dependsOn`), exposes a `KernelContext` containing `extensions`, `bus`, `hooks`, `rpc`, `clock`, `logger`, `paths`, and dispatches **12 hooks** with three execution modes. **Application** (`src/application/`) holds pure use-cases (e.g. `runTurnUsecase`, `compactSessionUsecase`) and the closed-union event contracts. **Domain** (`src/domain/`) holds pure data + generators (`turn-runner`, `compact-history`, identity / session / memory entities). **Infrastructure** (`src/infrastructure/`) hosts adapters (LLM SDKs, SQLite stores, Unix transport, job spawners). **Extensions** (`src/extensions/`) wire everything together — each extension is a small file that calls `defineExtension({ name, dependsOn?, enforce?, apply })` and returns hooks / RPC / slash / subscribe / dispose handles. There are currently **18 extensions** + a `presets.ts` aggregator.

---

## 1. Kernel

### 1.1 `defineExtension` & topological boot

- **Subject** — `src/kernel/define-extension.ts`, `src/kernel/topo-sort.ts`, `src/kernel/kernel.ts`.
- **Invariants**
  - Extensions are applied in topological order of `dependsOn`. Cycles must throw at boot.
  - `enforce: 'pre' | 'normal' | 'post'` is a *tiebreaker only* — it must never override `dependsOn`.
  - Every applied extension receives a `KernelContext` with the same instance of `bus`, `hooks`, `rpc`, `clock`, `logger`, `paths`.
  - `apply()` is called exactly once per extension per kernel lifetime.
- **Observable signals** — boot throws on cycle / missing dependency; `kernelReady` hook fires after every `apply()` returns.
- **Edge cases** — duplicate `name`; self-dependency; missing optional dependency; extension whose `apply()` rejects.
- **Current coverage** — `tests/kernel/define-extension.test.ts`, `tests/kernel/topo-sort.test.ts`, `tests/kernel/kernel.test.ts`, `tests/kernel/integration.test.ts`.
- **Coverage gaps** — *Given* two extensions both `enforce: 'post'` with no `dependsOn`, *when* booted, *then* registration order must be the stable tiebreaker (no test asserts stability today).

### 1.2 HookContainer (12 hooks, 3 modes)

- **Subject** — `src/kernel/hook-container.ts`.
- **Invariants** — `HOOK_MODES` has exactly the following 12 entries:

  | Hook | Mode |
  |---|---|
  | `configureKernel` | sequential |
  | `kernelReady` | parallel |
  | `onTurnStart` | sequential |
  | `transformPrompt` | sequential |
  | `resolveTools` | sequential |
  | `onToolCall` | sequential |
  | `onLLMDelta` | parallel |
  | `onTurnEnd` | parallel |
  | `onTraceEmit` | parallel |
  | `onIdentityChanged` | parallel |
  | `onShutdown` | sequential |
  | `serveControlMethod` | first-match |

  - `sequential` threads `args[0]` through each handler (`result = await h(result, …rest)`).
  - `parallel` swallows individual handler errors and logs through `Logger` if attached, otherwise `console.warn`.
  - `first-match` returns the first non-`undefined`, non-`null` result; otherwise `undefined`.
  - Within a hook, handlers are sorted by `(enforceWeight, order)` where `pre=0 < normal=1 < post=2`; ties keep registration order.

- **Observable signals** — `dispatch(name, ...args)` return value; warn logs on parallel failure.
- **Edge cases** — unknown hook name (defaults to `parallel` per `HOOK_MODES[name] ?? 'parallel'`); empty handler list returns `undefined`; sync handler that throws inside `parallel` mode (fixed 2026-05-24: `Promise.resolve()` replaced with `new Promise()` to catch sync throws); handler that mutates input in `sequential` mode.
- **Current coverage** — `tests/kernel/hook-container.test.ts`.
- **Coverage gaps** —
  - ~~*Given* `serveControlMethod` with a handler that returns `null`, *when* dispatched, *then* iteration must continue to the next handler.~~ Covered.
  - ~~*Given* a `parallel` hook handler that throws synchronously (not async), *then* dispatch must still resolve and log a warning.~~ Covered + fixed.
  - ~~*Given* `unregisterExtension(name)`, *then* subsequent `dispatch` must not invoke any of its handlers.~~ Covered.

### 1.3 EventBus

- **Subject** — `src/kernel/event-bus.ts`.
- **Invariants** — Pub/sub by event type; subscribers receive payload only; unsubscribe is idempotent; bus does not retain history.
- **Current coverage** — `tests/kernel/event-bus.test.ts`.
- **Coverage gaps** — back-pressure / re-entrancy (subscriber emits during dispatch) — currently untested.

### 1.4 RpcRegistry + `serveControlMethod`

- **Subject** — `src/kernel/rpc-registry.ts` (registry) and the `serveControlMethod` hook (delegated method resolution).
- **Invariants** — `register(name, handler)` is idempotent; a method name can be served either by a registry entry or by a `serveControlMethod` handler (first-match wins across handlers in declared order).
- **Observable signals** — return value or thrown error propagated to caller (`controlplane` transport adapter serializes).
- **Current coverage** — `tests/kernel/rpc-registry.test.ts` (unit), `tests/extensions/controlplane-methods.test.ts`, `tests/extensions/controlplane-jsonrpc.test.ts` (integration).

---

## 2. Application Layer

### 2.1 `runTurnUsecase` — the canonical turn loop

- **Subject** — `src/application/usecases/run-turn.ts` (orchestrator) + `src/domain/turn-runner.ts` (generator).
- **Pipeline (exactly seven phases)**
  1. Load history via `SessionHistoryPort.get(sessionId)`.
  2. **Auto-compact** if `approxTokens(historyText) > COMPACT_AUTO_THRESHOLD_TOKENS` (`80_000`). Calls `compactSessionUsecase`.
  3. `transformPrompt` hook (sequential) — extensions append / edit system-prompt fragments.
  4. `resolveTools` hook (sequential) — extensions extend the tool list given to the LLM.
  5. Register an `AbortController` keyed by `(sessionId, turnId)` so `input.cancel` can stop the turn.
  6. Drive the `runTurn` async generator. It yields:
     - `tool.start { call }`
     - `tool.end   { call, result }`
     - `tool.error { call, error }`
     - `turn.completed { messages, usage }`
     - `turn.failed   { error }`

     For every `tool.end`, a `ToolSink` is created per call and `flushSink` is invoked after success.
  7. `appendHistory` (new messages) → `onTurnEnd` hook (parallel) → emit `turn.completed` event on the bus.

- **Invariants**
  - At most **10** tool-call rounds per turn (`turn-runner` cap).
  - Tool calls within a round are executed **sequentially** in array order. There is no wave parallelism, no per-tool timeout wrapper in the dispatcher itself.
  - A `tool.error` does **not** abort the turn; the model receives the error and may retry.
  - Cancellation: aborting the controller causes the generator to yield `turn.failed` with an `AbortError`.

- **Observable signals** — bus events `turn.started`, `turn.completed`, `turn.failed`, tool-level events, history mutation via `appendHistory`.
- **Edge cases** — empty user message; provider returns no tool calls (turn completes in one round); the same tool called twice in one round (conflictKey may serialize); abort mid-stream; auto-compact failure (the turn should still proceed with the un-compacted history — verify against `compact-session.ts` reasons).
- **Current coverage** — `tests/application/usecases/run-turn.test.ts`, `tests/application/usecases/append-history.test.ts`, `tests/application/usecases/transform-prompt.test.ts`, `tests/application/usecases/resolve-tools.test.ts`, `tests/application/usecases/dispatch-tool.test.ts`, `tests/domain/turn-runner.test.ts`, `tests/domain/turn.test.ts`, `tests/application/tool-sink.test.ts`.
- **Coverage gaps** —
  - *Given* an auto-compact returning `reason: 'summary_failed'`, *when* the turn runs, *then* it must continue with the original history and emit a warning (no test today).
  - *Given* the 10-round cap is hit, *then* the generator must yield `turn.failed` with a distinct error code.
  - *Given* `AbortController.abort()` between `tool.start` and `tool.end`, *then* the in-flight tool result must be discarded and `turn.failed` yielded.

### 2.2 `compactSessionUsecase`

- **Subject** — `src/application/usecases/compact-session.ts`; helper `src/domain/compact-history.ts`; constants `src/application/constants/compact.ts` (`COMPACT_KEEP_RECENT = 4`, `COMPACT_MAX_OUTPUT_TOKENS = 1024`, `COMPACT_AUTO_THRESHOLD_TOKENS = 80_000`); compactor adapter `src/extensions/session/compactor.ts`.
- **Algorithm (single strategy, no tiers)**
  1. Read history.
  2. If `length ≤ keepRecent` → return early with `reason: 'below_threshold'`.
  3. Send `olderSlice = msgs.slice(0, len - keepRecent)` to `Compactor.summarize`. The compactor builds a `[system, user]` message pair from a flattened transcript and calls `ProviderInvoke.call({ kind: 'internal', purpose: 'session.compact', parentTurnId: 'compact:<sid>', maxTokens: COMPACT_MAX_OUTPUT_TOKENS })`.
  4. Replace history with `[summaryRecord, ...recent]` via `SessionHistoryPort.replace`.
  5. Emit `session.compacted` event with `{ sessionId, removedCount, summaryRecordId, usage, ts }`.
- **Invariants**
  - `keepRecent` defaults to `4`; callers may override per-call.
  - The summary record is an injected synthetic message with a stable id; its presence is the single signal that compaction occurred.
  - On `Compactor.summarize` rejection → `{ ok: false, reason: 'summary_failed' }` and history is **not** mutated.
  - On `history.replace` rejection → `{ ok: false, reason: 'replace_failed' }` and the event is **not** emitted.
  - Only the four `reason` values `'below_threshold' | 'summary_failed' | 'replace_failed' | undefined` (success) are returned.
- **Observable signals** — `session.compacted` event; history mutation; usage tokens reported in result.
- **Current coverage** — `tests/application/compact-session.test.ts`, `tests/domain/compact-history.test.ts`.
- **Coverage gaps** —
  - ~~*Given* `Compactor.summarize` resolves with an empty summary string, *then* the synthetic record should still be inserted.~~ Covered.
  - Idempotency under repeated calls with no new turns since the last compact.
  - *Given* the transcript includes a message with `blocks` but no string `content`, *then* the compactor must serialize `blocks` (covered implicitly in `compactor.ts`, but no end-to-end assertion exists).

### 2.3 Event-bus contracts

- **Subject** — `src/application/contracts/` (closed-union event types) + `asContractBus()` typed wrapper. The data-plane discriminated union lives in `application/contracts/dataplane-event.ts`.
- **Invariants** — Every emitted event matches a discriminant in the contracts file. Mis-typed events are caught at compile time.
- **Current coverage** — `tests/contracts/history-record-compat.test.ts`, `tests/schema/contract.test.ts`.
- **Coverage gaps** — *Given* every event constructor (`createEvent('xxx', ...)`), *when* round-tripped through `asContractBus().emit()`, *then* the payload must validate against the discriminated union. A property-based test would cover this exhaustively.

### 2.4 Slash commands

- **Subject** — `src/application/slash/` (builtins + dispatcher).
- **Coverage gaps** — *No dedicated slash test today.* ~~Add: *Given* an unknown command, *then* the dispatcher returns a structured error; *Given* `/compact`, *then* it invokes `compactSessionUsecase` with the current session id.~~ Registry + utils covered: `tests/application/slash/slash-registry.test.ts`, `tests/application/slash/slash-utils.test.ts`.

---

## 3. Domain Layer

| Subject | File | Current coverage |
|---|---|---|
| Turn runner generator | `domain/turn-runner.ts` | `tests/domain/turn-runner.test.ts` |
| Turn aggregate | `domain/turn.ts` | `tests/domain/turn.test.ts` |
| Session aggregate | `domain/session.ts` | `tests/domain/session.test.ts` |
| Identity entity | `domain/identity.ts` | `tests/domain/identity.test.ts` |
| MemoryEntry entity | `domain/memory-entry.ts` | `tests/domain/memory-entry.test.ts` |
| Skill descriptor | `domain/skill-descriptor.ts` | `tests/domain/skill-descriptor.test.ts` |
| Trace event | `domain/trace-event.ts` | `tests/domain/trace-event.test.ts` |
| Compact-history helper | `domain/compact-history.ts` | `tests/domain/compact-history.test.ts` |

**Universal invariants for domain code** — pure (no I/O, no `Date.now` without an injected clock), serializable, total where possible. Coverage here is the strongest in the repo. Future work: property-based fuzzing for `compact-history` and `turn-runner` to catch state-machine edge cases.

---

## 4. Extensions (18)

The presets aggregator (`src/extensions/presets.ts`) groups them as:

- **domainCore** — `tool-catalog`, `trace`, `provider`, `session`, `tools`, `permission`, `controlplane`, `controlplane.methods`, `dataplane`.
- **memory** — `memory`.
- **identity** — `identity`.
- **skills** — `skills` (factory takes options).
- **evolution** — `evolution`.
- **mcp** — `mcp`.
- **transports** — `transport.inmem`, `transport.unix`.
- **frontends** — `frontend.lark`, `frontend.tui`.

### 4.1 `tool-catalog`

- **Subject** — `src/extensions/tool-catalog/`.
- **Invariants** — Provides a `ToolCatalog` capability that stores `ToolDescriptor`s by name; `register` deduplicates by name; `list` returns a deterministic snapshot.
- **Coverage gaps** — Not separately tested; behavior covered indirectly via `tests/extensions/tools.test.ts`. Add a unit test on duplicate-name policy and snapshot determinism.

### 4.3 `provider`

- **Subject** — `src/extensions/provider/` (provides `ProviderInvoke`), adapters in `src/infrastructure/llm/adapters/`.
- **Invariants** — `invoke.call({ kind: 'turn' | 'internal', purpose, parentTurnId, messages, maxTokens?, ... })` returns `{ content, toolCalls, usage }`.
- **Current coverage** — `tests/extensions/provider.test.ts`.
- **Coverage gaps** — Streaming `onLLMDelta` parallel emission timing; back-pressure when a parallel subscriber is slow.

### 4.6 `tools`

- **Subject** — `src/extensions/tools/index.ts` registers 10 tools.
- **Invariants** — `resolveTools` hook merges the catalog into the LLM tool list; `transformPrompt` hook appends `TODO_WRITE_GUIDANCE`.
- **Current coverage** — `tests/extensions/tools.test.ts`, `tests/extensions/tools/todo-write.test.ts`.
- **Coverage gaps** — `conflictKey` semantics in the dispatcher (does it actually serialize on the key?).

### 4.8 `dataplane`

- **Subject** — `src/extensions/dataplane/index.ts`.
- **Invariants** — Subscribes to bus event types and re-emits as `dataplane.event` with monotonic `cursor` + `evId`. Discriminated union lives in `application/contracts/dataplane-event.ts`.
- **Current coverage** — `tests/extensions/dataplane.test.ts`.

### 4.9 `permission`

- **Subject** — `src/extensions/permission/index.ts`.
- **Invariants** — Intercepts `onToolCall` (pre phase). Deny-list blocks by tool name. Per-session allowlists (`allowOnce`) restrict tools to specific sessions. For `write` tool: emits `permission.required` event, blocks until `permission.resolve` RPC or timeout. `dispose()` rejects all pending requests.
- **Observable signals** — `permission.required` bus event; `onToolCall` throws for denied/not-allowed tools; RPC `permission.resolve`.
- **Edge cases** — concurrent write requests each get a distinct `reqId`; allowlist in one session does not leak to another; pending requests rejected on dispose.
- **Current coverage** — `tests/extensions/permission.test.ts`, `tests/extensions/permission-edge-cases.test.ts`.

### 4.11 `frontend.lark`

- **Subject** — `src/extensions/frontend.lark/`.
- **Current coverage** — `tests/extensions/lark-adapter.test.ts`.
- **Coverage gaps** — Only document files that exist in the directory; do not document imaginary subdirectories.

### 4.16 `memory`

- **Subject** — `src/extensions/memory/index.ts` + retrievers + store in `src/infrastructure/memory/`.
- **Invariants** — Provides `recall(query, opts)` and `store(entry)` capabilities. Default retriever is `HybridRetriever` with RRF (`k = 60`) fusing `KeywordRetriever`, `Bm25Retriever`, `VectorRetriever`. Weights: vector 0.5 / bm25 0.3 / keyword 0.2.
- **Current coverage** — `tests/extensions/memory.test.ts`, `tests/extensions/memory/policy.test.ts`, `tests/extensions/memory/retrievers.test.ts`.
- **Coverage gaps** — ~~Hybrid fusion under degraded modes (vector encoder throws → fall back to BM25 + keyword).~~ Covered.

---

## 5. Infrastructure

| Subsystem | Path | Coverage |
|---|---|---|
| LLM adapters (Claude, OpenAI) | `infrastructure/llm/` | adapter tests |
| Job spawner | `infrastructure/jobs/` | `tests/infrastructure/jobs/` |
| SQLite stores (agent, memory) | `infrastructure/agent/`, `infrastructure/memory/` | via extension tests |
| Unix transport server | `infrastructure/transport/` | `tests/extensions/transport-unix.test.ts` |

**Coverage gaps** — `InProcessExecutor` baseline test; atomic-write + ULID covered.

---

## 6. Test Coverage Matrix

Total: **85 test files**. Mirrors the `src/` structure.

| Layer | Test files | Coverage strength |
|---|---|---|
| `kernel/` | 8 | Strong |
| `domain/` | 9 | Strong — AbortController cancellation covered |
| `application/` | 10 | Strong on use-cases + slash + dispatch |
| `contracts/` + `schema/` | 2 | Adequate |
| `extensions/` | 31 | Broad — permission, skills reload, session NDJSON covered |
| `infrastructure/` | 4 | Mostly LLM-adapter focused |
| `mcp/` | 5 | Strong |
| `tui/` | 10 | Strong |
| `interface/` | 1 | Minimal |

### High-priority coverage gaps

1. Auto-compact failure path — turn proceeds with original history. *(Token threshold impractical for unit tests; compact-session level covered.)*
2. ~~Tool-call cancellation mid-flight (`AbortController`).~~ Covered: `tests/domain/turn-runner-abort.test.ts`.
3. `conflictKey` serialization in tool dispatch. *(Not yet implemented — metadata only.)*
4. ~~HookContainer parallel-mode sync throw and first-match null skip.~~ Covered + fixed.
5. ~~`RpcRegistry` unit test.~~ Covered.
6. ~~Memory hybrid retriever degraded modes.~~ Covered.
7. ~~Permission concurrent `write` requests (per-`reqId` isolation).~~ Covered.
8. ~~Slash dispatcher: unknown command + `/compact` happy path.~~ Registry + utils covered.
9. ~~Skill hot reload: `skills.reload` reflected in next `resolveTools`.~~ Covered: `tests/extensions/skills-hot-reload.test.ts`.
10. ~~Session NDJSON corruption tolerance on `restoreFromDisk`.~~ Covered: `tests/extensions/session-ndjson-restore.test.ts`.

---

## 9. Known-but-not-implemented (do **not** document as features)

The following appeared in older specs / READMEs but **have no implementation today**:

- Multi-tier (3 / 5-tier) compaction strategies.
- Sub-agent delegation and a sub-agent runner.
- Tool wave / parallel dispatch with timeout middleware.
- Trace redactor / nudge-engine.
- `memory.add` RPC method.
- `bots.yml` declarative agent manifest.
- Permission policy beyond the `write`-only blocking rule.
- A self-evolution defense queue / cron pipeline beyond `inflight = 1`.

---

## 10. How to use this document for TDD/BDD

1. Pick a section. Read its **Invariants** and **Observable signals**.
2. Check **Current coverage** — open the listed test files.
3. Pick one item from **Coverage gaps** and convert it to a failing test (red).
4. Make it pass with the smallest change (green).
5. Refactor without changing behavior; re-run the whole suite.
6. Update **Current coverage** with the new test path.

A change to behavior **must** appear in three places before merge:

- The code under `src/`.
- A test under `tests/` that fails before the change and passes after.
- The relevant section of this document.

A pull request that touches `src/` without updating one of the other two is, by convention, incomplete.
