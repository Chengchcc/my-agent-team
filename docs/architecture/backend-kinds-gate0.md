---
title: Backend Kinds Gate 0 Snapshot
description: Historical point-in-time (2026-08-12 to 08-13) protocol measurement snapshot for claude, pi, and omp CLIs — archival reference only, not a current-state contract
tags: [archive, acp, models, runs]
---

# Backend Kinds: Gate 0 Measurement Snapshot

> **Archive notice:** This page is a point-in-time measurement record from **2026-08-12 to 2026-08-13** capturing the raw CLI invocation flags, wire events, usage fields, and cancellation behavior of `claude`, `pi`, and `omp` before CrewDesk converged onto a single ACP rail (ADRs 0039/0040). It is **not** a current-state contract; for the active ACP implementation, see [ACP Backend Contract](./acp-backend-contract.md).

## Measured Environment (2026-08-12/13)

| Harness | Measured Version / Binary | Notes |
|---|---|---|
| `claude` | `/usr/bin/claude` (`@anthropic-ai/claude-code` 2.1.165 → 2.1.228) | Zero wire changes across upgrades; tested with local Anthropic credentials. |
| `pi` | `@earendil-works/pi-oma@0.84.1` (`pi`) | Captured live JSON wire (including undocumented `agent_settled`); `--session <path>` persistence verified. |
| `omp` | `@oh-my-pi/pi-oma@17.2.15` (`omp`) | Distinct product from `pi`; tested via `deepseek/deepseek-v4-flash` (`openai-completions`). |

## Observed Wire Summary

| Core Concept | `claude` (`stream-json`) | `pi` (`--mode json`) | `omp` (`--mode json`) |
|---|---|---|---|
| **Invocation** | `claude --output-format stream-json --input-format stream-json --verbose -p` | `pi -p --mode json --session <path> ...` | `omp -p --mode json [--session <path> \| -r <ref>] ...` |
| **Text / Thinking** | `assistant.message.content[text \| thinking]` | `message_update.{text_delta, thinking_delta}` | `message_update.{text_delta, thinking_delta}` |
| **Tool lifecycle** | `assistant.content[tool_use]` / `user.content[tool_result]` | `tool_execution_start` / `tool_execution_end` | `tool_execution_start` / `tool_execution_end` |
| **Usage authority** | `result.modelUsage` (+ `assistant.usage`) | `turn_end.message.usage` | `message_end.message.usage` |
| **Terminal signal** | `result` (`is_error`) / `error` / process exit | Process exit + exit code (`agent_end` messages) | `agent_end` + process exit |
| **Cancellation** | Process kill only (no in-protocol abort) | Process kill only | Process kill only |
| **MCP config** | `--mcp-config` `.mcp.json` | `.mcp.json` via `pi-mcp-adapter` | Workspace `.mcp.json` |

## Key Findings That Shaped Subsequent ADRs

1. **No in-protocol abort on legacy CLI modes:** all three external CLIs required process killing to cancel, motivating the later move to ACP (`session/cancel` + `session/request_permission` in ADRs 0039/0040).
2. **Root limitation on `claude`:** `--permission-mode bypassPermissions` / `--dangerously-skip-permissions` fails under `root`/`sudo`.
3. **Shared `.mcp.json` format:** all three CLIs accepted standard `{$schema, mcpServers}` workspace `.mcp.json`, directly motivating Workspace Bridge's single `.mcp.json` projection (ADR 0020).
4. **Forward compatibility:** external CLIs emit undocumented/new event types across minor updates (`thinking_tokens`, `agent_settled`); parsers must always ignore unknown event types.

## See also

- [ACP Backend Contract](./acp-backend-contract.md) — Current single-rail ACP architecture replacing per-CLI wire parsers
- [Workspaces & Projects](./workspaces-and-projects.md) — Current Workspace Bridge `.mcp.json` generation
- [ADR 0019](../adr/0019-cli-session-dual-truth.md) & [ADR 0020](../adr/0020-agent-workspace-and-resource-bridge.md)
