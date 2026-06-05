---
title: "AgentSpec"
type: concept
created: 2026-06-05
updated: 2026-06-05
sources:
  - raw/articles/12-agent-spec.md
tags: [backend, wire-schema, contract]
---

# AgentSpec

**Backend ↔ Runner wire schema.** An independent zod schema package defining the contract object for "one agent run." Dual-validated on both sides, with `schemaVersion` field preventing cross-process version mismatch.

## Why a separate package

Schema is a contract between two parties. Embedding it in backend creates:
- **Schema drift**: backend adds field, runner misses it
- **Undetected version mismatch**: v1.3 backend vs v1.1 runner → subtle bugs
- **Third-party runner friction**: sandbox vendors must extract types from backend

## Schema (V1)

```ts
const AgentSpecV1 = z.object({
  schemaVersion: z.literal('1'),
  workspace: z.string(),        // Runner-perspective path
  threadId: z.string(),
  model: z.object({
    provider: z.literal('anthropic'),
    model: z.string(),
    baseURL: z.string().optional(),
  }),
  apiKey: z.string().optional(),
  permissionMode: z.enum(['ask', 'auto', 'deny']).optional(),
  input: z.string(),
});
```

## Version evolution

- **Add optional field** → stays v1, forward-compatible (zod strips unknowns)
- **Breaking change** → bump to v2, export discriminated union, old runners hard-fail with clear error
- **Deprecation**: default v2, V1 deprecated, removed after one release cycle

## Harness does NOT depend on this

Harness takes destructured fields (`workspace`, `threadId`, `model`), not the AgentSpec object. Runner entry is responsible for unpacking. This keeps harness unaware of wire format versioning and allows local use without constructing spec objects.
