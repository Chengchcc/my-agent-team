import type { RunOpsDetail } from "@/lib/observability";

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function RunOpsTimeline({
  ops,
}: {
  ops: RunOpsDetail["ops"];
}) {
  if (ops.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        No ops events recorded.
      </p>
    );
  return (
    <div className="space-y-2">
      {ops.map((o) => (
        <div
          key={o.seq}
          className="flex items-start gap-3 border-l-2 border-muted pl-3"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-semibold">{o.kind}</span>
              <span className="text-muted-foreground text-xs">{ago(o.ts)}</span>
            </div>
            {Object.keys(o.payload).length > 0 && (
              <pre className="text-muted-foreground mt-0.5 text-xs overflow-x-auto">
                {JSON.stringify(o.payload, null, 2)}
              </pre>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
