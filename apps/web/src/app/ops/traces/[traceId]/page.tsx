import Link from "next/link";

export default async function TraceDetailPage({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  const { traceId } = await params;

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/ops/traces"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Traces
        </Link>
        <h1 className="text-xl font-bold font-mono">{traceId}</h1>
      </div>

      <div className="rounded-lg border p-4">
        <h2 className="text-lg font-semibold mb-2">Degraded Trace View</h2>
        <p className="text-muted-foreground">
          Full span waterfall unavailable. Enable OTLP export
          (MIRA_OBSERVABILITY_MODE=otlp) for complete trace visualization.
        </p>
        <p className="text-sm mt-2 text-muted-foreground">
          This trace ID was synthesized from local run_origin + run_ops_event
          data. Each run&apos;s ops events provide a partial trace waterfall.
        </p>
      </div>
    </div>
  );
}
