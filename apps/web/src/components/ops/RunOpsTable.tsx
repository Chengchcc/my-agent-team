"use client";
import Link from "next/link";
import type { RunOpsListItem } from "@/lib/api";

const statusColor: Record<string, string> = {
  running: "bg-blue-100 text-blue-800",
  succeeded: "bg-green-100 text-green-800",
  error: "bg-red-100 text-red-800",
  aborted: "bg-gray-100 text-gray-600",
  interrupted: "bg-orange-100 text-orange-800",
};

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function RunOpsTable({ runs }: { runs: RunOpsListItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Run ID</th>
            <th className="py-2 pr-3 font-medium">Agent</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">Kind</th>
            <th className="py-2 pr-3 font-medium">Transport</th>
            <th className="py-2 pr-3 font-medium">Heartbeat</th>
            <th className="py-2 pr-3 font-medium">Last Event</th>
            <th className="py-2 pr-3 font-medium">Started</th>
            <th className="py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.runId} className="border-b hover:bg-muted/50">
              <td className="py-2 pr-3 font-mono text-xs">
                {r.runId.slice(0, 12)}...
              </td>
              <td className="py-2 pr-3">{r.agentId}</td>
              <td className="py-2 pr-3">
                <span
                  className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                    statusColor[r.status] ?? "bg-gray-100 text-gray-600"
                  }`}
                >
                  {r.status}
                </span>
              </td>
              <td className="py-2 pr-3">{r.kind}</td>
              <td className="py-2 pr-3">{r.runnerTransport}</td>
              <td className="py-2 pr-3">
                {r.heartbeatAgeMs != null
                  ? `${Math.floor(r.heartbeatAgeMs / 1000)}s`
                  : "—"}
              </td>
              <td className="py-2 pr-3 text-xs">
                {r.lastOpsEventKind ?? r.lastEventType ?? "—"}
              </td>
              <td className="py-2 pr-3 text-xs">{ago(r.startedAt)} ago</td>
              <td className="py-2">
                <Link
                  href={`/ops/runs/${r.runId}`}
                  className="text-primary text-xs hover:underline"
                >
                  Detail
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
