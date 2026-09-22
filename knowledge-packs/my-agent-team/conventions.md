# Conventions

规则页的详表在 `docs/architecture/design-philosophy.md`、`e2e-contract-rules.md`、`db-typesafe-rules.md`。

## Imports

Cross-package imports MUST go through the barrel index.ts.
No deep imports like @chengchenccc/workflow/src/engine.js.

## Dependency injection

Backend uses composition-root DI without a framework. Every feature follows the
hexagonal split (domain / ports / service / adapter-sqlite / http / index).

## Agent session creation

`createOmaSession(opts)` 在 `apps/oh-my-agent/src/core/runtime/agent-loop.ts`，拿的是 sessionId、store、plugins、maxSteps、modelStream、approvalHandler 这些选项（没有 model 或 workspaceRoot）。Run 级装配的入口是 `createOmaRuntime(options)`（`core/runtime/create-runtime.ts`）。

后端派单在 `apps/backend/src/features/agent-run/execution-dispatch.ts`，经 `packages/adapter-oma-agent` spawn oma 子进程。每 Run 的 in-memory SessionStore 随 Run 销毁，但分支上的 `cli_session_ref` 会指向持久化的 CLI session。

## Plugin system

Plugins are plain objects { name, hooks?, tools?, meta? }. Hooks take an `rt` runtime context:

- beforeRun?(messages, rt) / afterRun?(status, messages, rt)
- beforeModel?(messages, rt) -> readonly Message[] / afterModel?(messages, rt)
- beforeTool?(toolName, input, rt) -> { block?, reason? } | undefined
- afterTool?(toolName, result, rt) -> OmaLoopEvent | { content?, isError?, terminate? } | undefined
- transformToolArgs?(toolName, input, rt) -> unknown
- beforeStop?(cancel, rt) / afterStop?(vetoed, rt)

validatePlugins() checks name/tool collisions; collectTools() assembles the per-run tool table.

## ChatModel contract

Core has no LLM dependency. ChatModel.stream(messages, opts?) is the contract.
Tests use echoModel() from @chengchenccc/test-helpers.

## File naming

Source: *.ts, tests: *.test.ts beside source (no __tests__ dirs).
Features use domain.ts, ports.ts, service.ts, adapter-sqlite.ts, http.ts, index.ts.

## Error handling

- Backend: Elysia onError maps DomainError subclasses to JSON.
- Service layer throws typed errors (ProjectNotFoundError, ValidationError).
- Workflow: node failures are captured per node-run; the execution terminalizes as failure.
- Agent: permissionMode="ask" tools go through the approval pipeline (approval_request -> resolve_approval; timeout denies).

## Commit rules

- Conventional commits with a mandatory scope from commitlint.config.mjs.
- No CJK anywhere in commit messages.
- Body lines max 100 chars.
- Husky pre-commit runs biome format + check over the repo.
