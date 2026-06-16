import type { ObservabilityConfig, ObservabilityMode } from "./types.js";

export function resolveObservabilityConfig(
  overrides?: Partial<ObservabilityConfig>,
): ObservabilityConfig {
  const mode = (overrides?.mode ??
    (process.env.MIRA_OBSERVABILITY_MODE as ObservabilityMode | undefined) ??
    (process.env.NODE_ENV === "test" ? "off" : "console")) as ObservabilityMode;

  const envRatio = process.env.MIRA_OTEL_SAMPLE_RATIO
    ? parseFloat(process.env.MIRA_OTEL_SAMPLE_RATIO)
    : NaN;
  const sampleRatio =
    overrides?.sampleRatio ??
    (Number.isFinite(envRatio) && envRatio >= 0 && envRatio <= 1 ? envRatio : 1.0);

  return {
    mode,
    serviceName: overrides?.serviceName ?? "backend",
    otlpEndpoint: overrides?.otlpEndpoint ?? process.env.MIRA_OTEL_EXPORTER_OTLP_ENDPOINT,
    sampleRatio,
    redact: "strict",
  };
}
