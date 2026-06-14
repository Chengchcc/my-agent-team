import { describe, test, expect } from "bun:test";
import { createRuntimeMetricSink } from "./metrics.js";
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

describe("RuntimeMetricSink", () => {
  test("off mode records without error", () => {
    const sink = createRuntimeMetricSink(offConfig);
    // Should not throw
    sink.recordHistogram("runtime.run.duration_ms", 100, {
      agent_id: "a1",
      status: "succeeded",
    });
    sink.recordCounter("runtime.surface.lark.card_update_failures", 1, {
      agent_id: "a1",
    });
    sink.recordGauge("runtime.runner.active_runs", 3, {
      agent_id: "a1",
    });
  });

  test("console mode records without error", () => {
    const sink = createRuntimeMetricSink(consoleConfig);
    sink.recordHistogram("runtime.run.duration_ms", 150, {
      agent_id: "a1",
      run_kind: "main",
      status: "succeeded",
    });
    sink.recordCounter("runtime.attempt.heartbeat_age_ms", 5000, {
      agent_id: "a1",
      status: "running",
    });
  });

  test("strips high-cardinality labels", () => {
    const sink = createRuntimeMetricSink(consoleConfig);
    // run_id, attempt_id, trace_id should be silently dropped as label keys
    // These should not throw — they just won't appear in the log
    sink.recordHistogram("runtime.run.duration_ms", 100, {
      agent_id: "a1",
      run_id: "r1",
      attempt_id: "a1",
      trace_id: "t1",
      status: "succeeded",
    });
  });
});
