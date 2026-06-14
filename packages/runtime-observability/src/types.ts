export interface RuntimeTraceContext {
  traceId: string;
  spanId?: string;
  traceparent: string;
  tracestate?: string;
}

export type RuntimeSpanName =
  | "backend.conversation.append"
  | "backend.run.schedule"
  | "backend.run.cancel"
  | "backend.run.recover"
  | "backend.run.retry"
  | "backend.eventlog.project"
  | "runner.daemon.start"
  | "runner.attempt.run"
  | "runner.model.call"
  | "runner.tool.call"
  | "runner.eventlog.append"
  | "lark.ingress.message"
  | "lark.surface.card.send"
  | "lark.surface.card.update";

export interface RuntimeSpanAttributes {
  "agent.id"?: string;
  "conversation.id"?: string;
  "thread.id"?: string;
  "run.id"?: string;
  "attempt.id"?: string;
  "run.kind"?: "main" | "reflect";
  "surface.kind"?: "web" | "lark";
  "eventlog.seq"?: number;
  "ledger.seq"?: number;
  "tool.name"?: string;
  "runner.transport"?: "socket" | "memory" | "noop";
}

export interface RuntimeTracer {
  startSpan<T>(
    name: RuntimeSpanName,
    attrs: RuntimeSpanAttributes,
    fn: () => Promise<T>,
  ): Promise<T>;
  currentTrace(): RuntimeTraceContext | null;
  inject(): RuntimeTraceContext;
  link(trace: RuntimeTraceContext, attrs?: Record<string, unknown>): void;
}

export type ObservabilityMode = "off" | "console" | "otlp";

export interface ObservabilityConfig {
  mode: ObservabilityMode;
  serviceName: "backend" | "runner-daemon" | "lark-bot" | "web";
  otlpEndpoint?: string;
  sampleRatio: number;
  redact: "strict";
}
