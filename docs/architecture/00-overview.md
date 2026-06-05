# Architecture Overview

## Goal

This repo builds a small agent stack from first principles: a caller provides messages, a model streams assistant output, tools may run, and results are fed back until the model ends the turn.

## Layers

```text
L4 Harness    opinionated product layer: built-in tools, prompts, permissions
L3 Framework  assembly layer: createAgent-style API over model + tools
L2 Runtime    run loop: messages -> model -> tools -> messages
L1 Protocols  type contracts: Message, ChatModel, Tool
```

M1 ships L1 and L2 in `@my-agent-team/core`, plus `@my-agent-team/test-helpers` for reusable scripted model tests.

M2 adds `@my-agent-team/adapter-anthropic` (Anthropic `ChatModel` implementation via `@anthropic-ai/sdk`), `@my-agent-team/tools-common` (6 reusable tools: web_fetch, web_search, memory_save, memory_recall, read, write), and `@my-agent-team/cli` (`apps/cli`, interactive entry point).

## Design Principles

1. No protocol without proven need: add fields only for real repeated pain, not imagined future cases.
2. No deep imports: package consumers enter through `index.ts` exports.
3. Composition over hooks: if normal JavaScript function wrapping solves it, do not add a framework hook.
4. State belongs to caller by default: `messages` is owned by the caller and advanced by the runtime.
5. Layer downward dependency: L4 can depend on L3/L2/L1; reverse dependency is a bug.
6. AsyncIterable is the event stream: do not introduce an EventBus or Observer for M1.
7. One concept, one name: keep protocol names consistent across packages.
8. Rule of three: extract shared abstraction on the third real repetition.

## Runtime Contract

`run(model, tools, messages, options)` is an async generator. It streams assistant snapshots while the model emits deltas, appends completed assistant messages to the caller-owned `messages` array, executes requested tools serially, appends tool results as user messages, and stops when there are no tool calls or `maxSteps` is reached.

Model errors propagate to the caller. Tool errors become `tool_result` blocks with `is_error: true` so the model can continue from the error context.
