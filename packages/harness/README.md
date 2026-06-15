# @my-agent-team/harness

> **Layer:** L4 Harness &nbsp;|&nbsp; **Depends on:** framework, core, all 3 plugins, tools-common, agent-fs

## Position in the stack

```
┌──────────────────────────────────────────┐
│ L6  Surfaces     web / cli / lark-bot    │
│ L5  Backend      HTTP/SSE server         │
├──────────────────────────────────────────┤
│ L4  Harness      opinionated agent ◄─ HERE
│ L3  Framework    plugins + composition   │
│ L2  Runtime      run() loop              │
│ L1  Protocols    Message/Tool/ChatModel  │
└──────────────────────────────────────────┘
```

## What problem it solves

Framework gives you Lego bricks. Harness is the pre-built set — a single `createGenericAgent()` call that gives you a fully-configured agent with all default plugins, tools, system prompt, workspace sandboxing, and lifecycle hooks. This is the "product" layer: it encodes opinions about how an agent should behave.

## What gets wired together

```
createGenericAgent()
│
├── System prompt ───────→ BOOTSTRAP.md + agent persona
├── Plugins ─────────────→ fsMemoryPlugin (persistent memory)
│                          progressiveSkillPlugin (SKILL.md loading)
│                          taskGuardPlugin (todo planning + stop guard)
├── Tools ───────────────→ read/write/edit (workspace-scoped via AgentFS)
│                          bash, glob, grep
│                          webFetch, webSearch
├── Context manager ─────→ slidingWindow + toolResultTruncator
├── Checkpointer ────────→ sqliteCheckpointer (persistence)
├── Workspace ───────────→ AgentFS (shared/private/POSIX roots)
└── Lifecycle hooks ─────→ bootstrap (genesis)
                           reflectionGuidance (post-run)
                           verificationGuidance (completion check)
```

## Lifecycle

```
first run?
  ├── YES → bootstrap() → write BOOTSTRAP.md → set isGenesis=true
  └── NO  → continue

agent.run(input)
  │
  ├── taskGuardPlugin generates todo plan
  ├── agent loop: model ↔ tools
  ├── agent decides to stop
  │
  ├── taskGuardPlugin validates: todos done? tool errors?
  ├── agent calls stop tool
  │
  └── backend triggers reflection run
       └── reflectionGuidance() → agent reviews its own work
```

## Key exports

| Export | What | Why |
|--------|------|-----|
| `createGenericAgent(opts)` | `→ Agent` | One-call fully-configured agent |
| `bootstrap(ws)` | `→ { isGenesis }` | First-run workspace setup |
| `reflectionGuidance()` | `→ string` | System prompt for post-run review |
| `verificationGuidance()` | `→ string` | System prompt for completion check |
| `GenericAgentOptions` | Type | All config options |

## Usage

```ts
import { createGenericAgent } from "@my-agent-team/harness";
import { makeDevAgentFsHandle } from "@my-agent-team/agent-fs";

const fs = makeDevAgentFsHandle({ workspaceDir: "/tmp/agent-42" });

const agent = createGenericAgent({
  workspace: fs,
  model: new AnthropicChatModel({ apiKey: "..." }),
  threadId: "thread-1",
  permissionMode: "default",
  logger: consoleLogger,
});

for await (const event of agent.run("Fix the bug in auth.ts")) {
  // stream to SSE, CLI, etc.
}
```

## Dependencies

```
harness (this package)
  ↑ depends on: core, framework, plugin-fs-memory,
                plugin-progressive-skill, plugin-task-guard,
                tools-common, agent-fs
  ↑ depended on by: runner-daemon, apps/cli, apps/backend
```
