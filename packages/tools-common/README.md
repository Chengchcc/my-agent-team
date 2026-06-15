# @my-agent-team/tools-common

> **Layer:** Tools &nbsp;|&nbsp; **Depends on:** `@my-agent-team/core`

## Position in the stack

```
┌──────────────────────────────────────────┐
│ L4  Harness ────┐                        │
│                 │ wires together         │
│          ┌──────▼──────┐                 │
│          │ tools-common │  ◄── HERE      │
│          │ bash, read,  │                │
│          │ write, grep, │                │
│          │ glob, web,   │                │
│          │ memory       │                │
│          └─────────────┘                 │
└──────────────────────────────────────────┘
```

## What problem it solves

Agents need standard tools to be useful: filesystem operations, code search, bash execution, web access, memory. This package provides these as `Tool` implementations conforming to core's `Tool` interface. The harness picks from this catalog and wires the relevant ones into each agent.

## Tool catalog

### Filesystem tools (process-cwd)

| Tool | What it does |
|------|-------------|
| `readTool` | Read file content |
| `writeTool` | Write file content (overwrite) |
| `editTool` | Exact string replacement in file |

### Filesystem tools (workspace-scoped via AgentFS)

| Factory | What it produces |
|---------|-----------------|
| `createReadToolForWorkspace(fs)` | Read through AgentFS |
| `createWriteToolForWorkspace(fs)` | Write through AgentFS |
| `createEditToolForWorkspace(fs)` | Edit through AgentFS |

### Search tools

| Tool | What it does |
|------|-------------|
| `grepTool` | Regex search across files |
| `globTool` | Glob pattern file matching |

### Execution

| Tool | What it does |
|------|-------------|
| `bashTool` | Execute bash commands in sandbox |

### Web tools

| Tool | What it does |
|------|-------------|
| `webFetchTool` | Fetch URL, convert HTML → markdown |
| `createWebSearchTool(apiKey)` | Web search via Tavily API |

### Memory tools (in-memory, Map-backed)

| Factory | What it produces |
|---------|-----------------|
| `createMemorySaveTool(store)` | Save key-value pair in memory |
| `createMemoryRecallTool(store)` | Recall value by key |

> **Note:** For persistent file-backed memory, use `fsMemoryPlugin` from `@my-agent-team/plugin-fs-memory` instead.

## Usage

```ts
import { bashTool, grepTool, createReadToolForWorkspace } from "@my-agent-team/tools-common";

// Standalone cwd-based
const tools = [bashTool, grepTool];

// Workspace-scoped with AgentFS
const readWs = createReadToolForWorkspace(agentFsHandle);
const tools = [bashTool, grepTool, readWs];
```

## Dependencies

```
tools-common (this package)
  ↑ depends on: core
  ↑ depended on by: harness, plugin-fs-memory, plugin-progressive-skill, apps/cli
```
