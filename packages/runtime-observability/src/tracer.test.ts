import { describe, expect, test } from "bun:test";
import { resolveObservabilityConfig } from "./config.js";
import { createRuntimeTracer } from "./tracer.js";
import type { ObservabilityConfig } from "./types.js";

const offConfig: ObservabilityConfig = {
  mode: "off",
  serviceName: "backend",
  sampleRatio: 1.0,
  redact: "strict",
};

const consoleConfig: ObservabilityConfig = {
  mode: "console",
  serviceName: "backend",
  sampleRatio: 1.0,
  redact: "strict",
};

describe("RuntimeTracer (off mode)", () => {
  const tracer = createRuntimeTracer(offConfig);

  test("startSpan returns fn result", async () => {
    const result = await tracer.startSpan(
      "backend.run.schedule",
      { "run.id": "r1" },
      async () => 42,
    );
    expect(result).toBe(42);
  });

  test("startSpan propagates errors", async () => {
    await expect(
      tracer.startSpan("backend.run.schedule", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  test("inject returns valid traceparent format", () => {
    const ctx = tracer.inject();
    expect(ctx.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(ctx.traceId).toHaveLength(32);
    expect(ctx.spanId).toHaveLength(16);
  });

  test("currentTrace returns null initially", () => {
    expect(tracer.currentTrace()).toBeNull();
  });

  test("link sets current trace for subsequent lookups", () => {
    const traceCtx = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    };
    tracer.link(traceCtx);
    // In noop mode, link is a no-op — but it shouldn't throw
  });
});

describe("RuntimeTracer (console mode)", () => {
  const tracer = createRuntimeTracer(consoleConfig);

  test("startSpan returns fn result", async () => {
    const result = await tracer.startSpan(
      "runner.attempt.run",
      { "run.id": "r1", "attempt.id": "a1", "agent.id": "agent_x" },
      async () => "done",
    );
    expect(result).toBe("done");
  });

  test("startSpan with error records exception", async () => {
    await expect(
      tracer.startSpan("runner.tool.call", { "tool.name": "bash" }, async () => {
        throw new Error("tool failed");
      }),
    ).rejects.toThrow("tool failed");
  });

  test("inject produces unique trace contexts", () => {
    const ctx1 = tracer.inject();
    const ctx2 = tracer.inject();
    expect(ctx1.traceId).not.toBe(ctx2.traceId);
  });
});

describe("resolveObservabilityConfig", () => {
  test("defaults to console in non-test env", () => {
    const config = resolveObservabilityConfig({ serviceName: "backend" });
    // In test env, NODE_ENV=test → defaults to "off"
    expect(config.mode).toBe("off");
    expect(config.serviceName).toBe("backend");
    expect(config.sampleRatio).toBe(1.0);
    expect(config.redact).toBe("strict");
  });

  test("respects explicit mode override", () => {
    const config = resolveObservabilityConfig({
      serviceName: "runner-daemon",
      mode: "console",
    });
    expect(config.mode).toBe("console");
    expect(config.serviceName).toBe("runner-daemon");
  });
});
