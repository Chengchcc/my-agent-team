---
title: "Summary: Framework vs Harness vs Backend"
type: summary
created: 2026-06-05
source: raw/articles/10-harness-vs-framework.md
tags: [comparison, boundaries, anti-patterns]
---

# 10 — Framework vs Harness vs Backend

Three-layer comparison: assembly kit vs product vs hosting service.

**Hard boundaries**: Framework has no domain assumption — caller passes model/tools. Harness has domain assumption — caller passes workspace/business params. Backend has multi-tenant assumption — manages agentId and HTTP.

**Project division**: Framework produces Agent/Plugin/Checkpointer/ContextManager/Logger (zero tools, zero system prompt). Harness produces createGenericAgent (fixed tools/plugins, workspace-driven prompt). Backend produces HTTP server + agent pool + runner entries.

**Anti-patterns**: Framework with default tools/prompts, Harness exposing Plugin[], Harness knowing agentId/sandbox, Backend skipping Harness to call runtime directly, per-domain harness packages (should be templates).
