---
title: "Summary: Harness"
type: summary
created: 2026-06-05
source: raw/articles/08-harness.md
tags: [harness, L4, concept]
---

# 08 — Harness

Defines the Harness concept: domain-closed + zero-assembly + behavior-locked agent product. Two forms: code-driven (npm package per domain) vs file-driven (workspace files control behavior — adopted).

**Bootstrap protocol**: 6 workspace files read concurrently → systemPrompt composed → framework assembled with builtin tools + 3 plugins (fs-memory, progressive-skill, permission).

**Backend boundary**: Harness only knows `workspace path + threadId + model`. Backend owns agentId, workspace materialization, sandbox, transport. Workspace path is the sole handoff.

**Permanent contracts**: No process.env, no process.cwd(), no agentId/sandbox/HTTP knowledge, no network dependencies, no AGENTS.md parsing.
