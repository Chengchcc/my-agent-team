# @my-agent-team/runtime-observability

> **Layer:** Infrastructure &nbsp;|&nbsp; **Dependencies:** `@opentelemetry/api` only

## Position in the stack

```
┌──────────────────────────────────────────┐
│ L5  Backend ────┐                        │
│                 │ setup tracing          │
│          ┌──────▼──────────────┐         │
│          │runtime-observability │◄── HERE │
│          │OpenTelemetry spans  │         │
│          │metrics + redaction  │         │
│          └──────┬──────────────┘         │
│                 │                        │
│ Runner Daemon ──┘ (trace context via     │
│                    start message)        │
└──────────────────────────────────────────┘
```

## What problem it solves

Multi-agent runs across process boundaries need distributed tracing to debug latency, errors, and bottlenecks. This package wraps OpenTelemetry to provide pre-defined spans for agent operations, propagates trace context across the backend→daemon boundary, and redacts sensitive attributes.

## Trace flow

```
Backend                            Runner Daemon
───────                            ─────────────
createSpan("agent.run")
  │
  │ inject trace context
  │ into start message ──────────→ extract trace context
  │                                 createSpan("daemon.handle_start")
  │                                   │
  │                                   ├── createSpan("agent.model_call")
  │                                   ├── createSpan("agent.tool_execute")
  │                                   └── createSpan("agent.reflection")
  │
  │ on run_done
  ├── record metrics (duration, tokens, tool calls)
  └── endSpan("agent.run")
```

## Spans created

| Span | When |
|------|------|
| `agent.run` | Full run lifecycle (backend side) |
| `daemon.handle_start` | Daemon receives and validates start |
| `agent.model_call` | Each model invocation |
| `agent.tool_execute` | Each tool execution |
| `agent.reflection` | Post-run reflection pass |

## Attribute redaction

`redactAttributes()` strips sensitive keys before export:

```
Before: { "anthropic.api_key": "sk-...", "model": "claude-sonnet-4-6" }
After:  { "anthropic.api_key": "[REDACTED]", "model": "claude-sonnet-4-6" }
```

## Key exports

| Export | What | Why |
|--------|------|-----|
| `createRuntimeTracer(config)` | `→ RuntimeTracer` | OTEL tracer with pre-defined spans |
| `createRuntimeMetricSink()` | `→ RuntimeMetricSink` | Run-level metrics collection |
| `resolveObservabilityConfig(config)` | `→ ObservabilityConfig` | Env-based configuration |
| `redactAttributes(attrs)` | `→ Record<string,unknown>` | Strip sensitive values |
| `RuntimeTraceContext` | Type | Trace context for cross-process propagation |
| `ObservabilityMode` | `"disabled" \| "otel"` | Mode enum |

## Dependencies

```
runtime-observability (this package)
  ↑ depends on: @opentelemetry/api
  ↑ depended on by: runner-protocol, apps/backend
```
