import { trace, SpanStatusCode } from "@opentelemetry/api";
import type {
  RuntimeTracer,
  RuntimeTraceContext,
  RuntimeSpanName,
  RuntimeSpanAttributes,
  ObservabilityConfig,
} from "./types.js";
import { redactAttributes } from "./redaction.js";

function generateTraceId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function generateSpanId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export function createRuntimeTracer(
  config: ObservabilityConfig,
): RuntimeTracer {
  if (config.mode === "off") return createNoopTracer();

  const otelTracer = trace.getTracer(config.serviceName);
  let currentTrace: RuntimeTraceContext | null = null;

  return {
    async startSpan<T>(
      name: RuntimeSpanName,
      attrs: RuntimeSpanAttributes,
      fn: () => Promise<T>,
    ): Promise<T> {
      const safeAttrs = redactAttributes(attrs);
      const span = otelTracer.startSpan(name, {
        attributes: safeAttrs as Record<string, unknown>,
      });
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (e) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: e instanceof Error ? e.message : String(e),
        });
        span.recordException(e as Error);
        throw e;
      } finally {
        span.end();
      }
    },

    currentTrace(): RuntimeTraceContext | null {
      return currentTrace;
    },

    inject(): RuntimeTraceContext {
      const spanContext = trace.getActiveSpan()?.spanContext();
      const traceId = spanContext?.traceId ?? generateTraceId();
      const spanId = spanContext?.spanId ?? generateSpanId();
      const traceparent = `00-${traceId}-${spanId}-01`;
      const ctx: RuntimeTraceContext = { traceId, spanId, traceparent };
      currentTrace = ctx;
      return ctx;
    },

    link(traceCtx: RuntimeTraceContext, _attrs?: Record<string, unknown>): void {
      currentTrace = traceCtx;
    },
  };
}

function createNoopTracer(): RuntimeTracer {
  return {
    async startSpan<T>(_name, _attrs, fn) {
      return fn();
    },
    currentTrace() {
      return null;
    },
    inject(): RuntimeTraceContext {
      const traceId = generateTraceId();
      const spanId = generateSpanId();
      return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` };
    },
    link() {},
  };
}
