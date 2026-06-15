# @my-agent-team/agent-fs

> **Layer:** Infrastructure &nbsp;|&nbsp; **Dependencies:** zero

## Position in the stack

```
┌──────────────────────────────────────────┐
│ L4  Harness ────┐                        │
│ L3  Framework   │                        │
│ L2  Runtime     │                        │
│ L1  Protocols   │                        │
├─────────────────┼────────────────────────┤
│ Infrastructure  │                        │
│          ┌──────▼──────┐                 │
│          │   agent-fs   │  ◄── HERE      │
│          │  virtual FS  │                │
│          │  sandbox     │                │
│          └─────────────┘                 │
└──────────────────────────────────────────┘
```

## What problem it solves

An agent needs to read and write files — but giving it raw filesystem access is dangerous. AgentFS provides a **capability-based virtual filesystem** with separate roots for shared data, private data, and optional POSIX paths. Tools operate through the virtual FS, which enforces mount boundaries.

## Sandbox model

```
┌─────────────────────────────────────────────┐
│                 AgentFS                      │
│                                              │
│  Mount Table:                                │
│  ┌──────────────┬──────────────────────────┐ │
│  │ /shared      │ → MemoryBackend          │ │
│  │ /private     │ → MemoryBackend          │ │
│  │ /workspace   │ → LocalBackend (posix)   │ │
│  │ /posix/home  │ → LocalBackend (posix)   │ │
│  └──────────────┴──────────────────────────┘ │
│                                              │
│  Logical path → resolved through mount table  │
│  Access errors → AgentFsAccessError          │
└─────────────────────────────────────────────┘
```

## Backend types

| Backend | Storage | Use case |
|---------|---------|----------|
| `MemoryBackend` | In-memory Map | Ephemeral data, tests |
| `LocalBackend` | Real filesystem | Persistent workspace files |

## Capability profiles

| Factory | Shared | Private | POSIX |
|---------|--------|---------|-------|
| `makeDevAgentFsHandle()` | ✓ | ✓ | ✓ (full) |
| `makeSharedOnlyAgentFS()` | ✓ | ✗ | ✗ |
| `makeExternalMount()` | ✓ | ✗ | Read-only specific dir |

## Key exports

| Export | What | Why |
|--------|------|-----|
| `AgentFS` | Virtual filesystem class | Mount-resolving read/write |
| `AgentFsHandle` | Configured handle | Roots + domain + mount table |
| `MemoryBackend` | In-memory backend | Ephemeral storage |
| `LocalBackend` | Real FS backend | Persistent storage |
| `makeDefaultMounts()` | Mount factory | Standard workspace setup |
| `makeDevAgentFsHandle()` | Handle factory | Full dev access |
| `makeSharedOnlyAgentFS()` | Handle factory | Restricted access |
| `isSharedLogicalPath()` | `(path) → boolean` | Classify path as shared |
| `AgentFsAccessError` | Error class | Capability violation signal |

## Usage

```ts
import { AgentFS, MemoryBackend, LocalBackend } from "@my-agent-team/agent-fs";

const fs = new AgentFS({
  mounts: {
    "/shared":   { backend: new MemoryBackend() },
    "/private":  { backend: new MemoryBackend() },
    "/workspace": { backend: new LocalBackend({ root: "/data/agent-42" }) },
  },
});

await fs.write("user.txt", "hello", { root: "shared" });
const content = await fs.read("user.txt", { root: "shared" });
```

## Dependencies

```
agent-fs (this package)
  ↑ depends on: nothing
  ↑ depended on by: harness, tools-common, plugin-fs-memory,
                     plugin-progressive-skill, runner-daemon
```
