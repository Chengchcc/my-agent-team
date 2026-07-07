"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LoopDetail } from "@/lib/api";
import { ReviewActionBar } from "./ReviewActionBar";

type LoopItem = NonNullable<NonNullable<LoopDetail>["items"]>[number];

const VERDICT_TONE: Record<string, string> = {
  PASS: "bg-emerald-500/15 text-emerald-700",
  REJECT: "bg-rose-500/15 text-rose-700",
  ESCALATE: "bg-amber-500/15 text-amber-700",
};

function VerdictBlock({ result }: { result: NonNullable<LoopItem["result"]> }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className={`text-xs ${VERDICT_TONE[result.verdict] ?? ""}`}>
          {result.verdict}
        </Badge>
      </div>
      {"reasons" in result && result.reasons.length > 0 && (
        <div>
          <p className="text-xs text-[var(--mute)] mb-1">Reasons</p>
          <ul className="text-sm space-y-1 list-disc list-inside">
            {result.reasons.map((r: string, i: number) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {result.evidence && (
        <div>
          <p className="text-xs text-[var(--mute)] mb-1">Evidence</p>
          <pre className="text-sm whitespace-pre-wrap font-sans bg-[var(--canvas)] rounded p-2 border border-[var(--hairline)]">
            {result.evidence}
          </pre>
        </div>
      )}
    </div>
  );
}

export function EvidenceChainPanel({ loopId, item }: { loopId: string; item: LoopItem | null }) {
  if (!item) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-[var(--mute)]">Select an item to view its evidence chain.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Item</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-[var(--mute)]">Source</span>
            <span className="font-mono text-xs">{item.source}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--mute)]">Step</span>
            <Badge variant="outline" className="text-xs">
              {item.step}
            </Badge>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--mute)]">Attempt</span>
            <span>{item.attempt}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--mute)]">Priority</span>
            <span>{item.priority}</span>
          </div>
          <div>
            <p className="text-[var(--mute)] mb-1">Summary</p>
            <p>{item.summary}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Evaluator Verdict</CardTitle>
        </CardHeader>
        <CardContent>
          {item.result ? (
            <VerdictBlock result={item.result} />
          ) : (
            <p className="text-sm text-[var(--mute)]">No verdict yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Review</CardTitle>
        </CardHeader>
        <CardContent>
          <ReviewActionBar loopId={loopId} item={item} />
        </CardContent>
      </Card>
    </div>
  );
}
