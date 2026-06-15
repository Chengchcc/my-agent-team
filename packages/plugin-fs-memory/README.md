# @my-agent-team/plugin-fs-memory

> **Layer:** L3 Plugin &nbsp;|&nbsp; **Depends on:** core, framework, tools-common

## Position in the stack

```
┌──────────────────────────────────────────┐
│ L4  Harness ────┐                        │
│                 │ default plugin         │
│          ┌──────▼──────────────┐         │
│          │ plugin-fs-memory     │ ◄─ HERE │
│          │ persistent file-based│         │
│          │ memory for agents    │         │
│          └─────────────────────┘         │
│ L3  Framework    definePlugin()          │
└──────────────────────────────────────────┘
```

## What problem it solves

Agents need memory that persists across runs: user preferences, project context, decisions made. This plugin provides file-backed persistent memory as a framework plugin. Memory files live in `/memory/` within the agent's workspace, and relevant content is injected into the system prompt at the start of each run.

## Architecture

```
┌──────────────────────────────────────────────┐
│           fsMemoryPlugin()                    │
│                                               │
│  Tools contributed:                           │
│  ┌──────────────────────────────────────┐     │
│  │ memory_read  → read file from /memory│     │
│  │ memory_write → write file to /memory │     │
│  │ memory_search→ grep across /memory   │     │
│  └──────────────────────────────────────┘     │
│                                               │
│  Hooks:                                       │
│  ┌──────────────────────────────────────┐     │
│  │ beforeModel (first turn only):       │     │
│  │   1. Scan /memory/ for files         │     │
│  │   2. Inject content into system msg  │     │
│  └──────────────────────────────────────┘     │
└──────────────────────────────────────────────┘
```

## Memory file format

Each memory file is a markdown file with YAML frontmatter:

```markdown
---
name: git-commit-author
description: Use chengchen author for commits
metadata:
  type: user
---

Use `chengchen` as git commit author. Omit Co-Authored-By.
```

## vs tools-common memory tools

| Feature | `tools-common` memory tools | `plugin-fs-memory` |
|---------|---------------------------|-------------------|
| Storage | In-memory Map | Filesystem (workspace `/memory/`) |
| Persistence | Lost on restart | Survives restarts |
| Bootstrap injection | No | Yes — injected into system prompt |
| Search | Key lookup only | Full-text grep across all memory files |

## Key exports

| Export | What | Why |
|--------|------|-----|
| `fsMemoryPlugin(opts)` | `→ Plugin` | Persistent memory plugin |
| `FsMemoryOptions` | Type | `{ ws, root, enableWrite, searchLimit }` |

## Usage

```ts
import { fsMemoryPlugin } from "@my-agent-team/plugin-fs-memory";
import { createAgent } from "@my-agent-team/framework";

const agent = createAgent({
  model: "...",
  plugins: [
    fsMemoryPlugin({ ws: "/agent-workspace" }),
  ],
});
```

## Dependencies

```
plugin-fs-memory (this package)
  ↑ depends on: core, framework, tools-common
  ↑ depended on by: harness (as default plugin)
```
