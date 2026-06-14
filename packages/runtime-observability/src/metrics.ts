import type { ObservabilityConfig } from "./types.js";

export interface RuntimeMetricSink {
  recordHistogram(
    name: string,
    value: number,
    labels: Record<string, string>,
  ): void;
  recordCounter(
    name: string,
    value: number,
    labels: Record<string, string>,
  ): void;
  recordGauge(
    name: string,
    value: number,
    labels: Record<string, string>,
  ): void;
}

const ALLOWED_METRIC_LABEL_KEYS = new Set(["agent_id", "run_kind", "status"]);

function sanitizeLabels(
  labels: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (ALLOWED_METRIC_LABEL_KEYS.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

export function createRuntimeMetricSink(
  config: ObservabilityConfig,
): RuntimeMetricSink {
  if (config.mode === "off") return createNoopMetricSink();
  return createConsoleMetricSink();
}

function createConsoleMetricSink(): RuntimeMetricSink {
  return {
    recordHistogram(name, value, labels) {
      console.log(
        `[metrics] histogram ${name}=${value} ${JSON.stringify(sanitizeLabels(labels))}`,
      );
    },
    recordCounter(name, value, labels) {
      console.log(
        `[metrics] counter ${name}=${value} ${JSON.stringify(sanitizeLabels(labels))}`,
      );
    },
    recordGauge(name, value, labels) {
      console.log(
        `[metrics] gauge ${name}=${value} ${JSON.stringify(sanitizeLabels(labels))}`,
      );
    },
  };
}

function createNoopMetricSink(): RuntimeMetricSink {
  return {
    recordHistogram() {},
    recordCounter() {},
    recordGauge() {},
  };
}
