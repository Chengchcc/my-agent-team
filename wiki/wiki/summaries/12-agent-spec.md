---
title: "Summary: AgentSpec"
type: summary
created: 2026-06-05
source: raw/articles/12-agent-spec.md
tags: [agent-spec, wire-schema, contract]
---

# 12 — AgentSpec

Independent zod schema package. Backend ↔ Runner wire contract with bidirectional validation.

**Why independent**: Prevents schema drift, detects version mismatch explicitly, supports third-party runners, enables cross-language codegen.

**V1 schema**: `{ schemaVersion, workspace, threadId, model, apiKey?, permissionMode?, input }`. Dual-validated: backend validates before sending, runner validates on receipt.

**Version evolution**: Add optional field → stays v1 (forward-compatible). Breaking change → bump to v2 with discriminated union, old runners hard-fail.

**Harness independence**: Harness takes destructured fields, not AgentSpec object. This decouples harness from wire format versions.

**Future**: JSON Schema generation for cross-language runners (Go/Rust/Python) when needed. YAGNI for now.
