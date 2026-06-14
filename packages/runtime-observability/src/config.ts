import type { ObservabilityConfig, ObservabilityMode } from "./types.js";

export function resolveObservabilityConfig(
  overrides?: Partial<ObservabilityConfig>,
): ObservabilityConfig {
  const mode = (overrides?.mode ??
    (process.env.MIRA_OBSERVABILITY_MODE as ObservabilityMode | undefined) ??
    (process.env.NODE_ENV === "test" ? "off" : "console")) as ObservabilityMode;

  return {
    mode,
    serviceName: overrides?.serviceName ?? "backend",
    otlpEndpoint:
      overrides?.otlpEndpoint ?? process.env.MIRA_OTEL_EXPORTER_OTLP_ENDPOINT,
    sampleRatio:
      overrides?.sampleRatio ??
      (process.env.MIRA_OTEL_SAMPLE_RATIO
        ? parseFloat(process.env.MIRA_OTEL_SAMPLE_RATIO)
        : 1.0),
    redact: "strict",
  };
}
