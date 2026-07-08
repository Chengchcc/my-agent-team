"use client";

import { conversationEvents } from "@my-agent-team/api-contract";
import { deserializeLedgerContent, extractText } from "@my-agent-team/message";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LoopDetail } from "@/lib/api";
import { typedSource } from "@/lib/typed-source";
import { ReviewActionBar } from "./ReviewActionBar";

type LoopItem = NonNullable<NonNullable<LoopDetail>["items"]>[number];

/** Fetch the generator's assistant output for a loop item.
 *  loopId = conversationId; generatorSpanId identifies the Generator run.
 *  Reads the conversation ledger via SSE (afterSeq=0 replays full history),
 *  filters to the last assistant message tagged with that spanId, and returns
 *  its displayable text. Closes the stream once history is drained. */
function useGeneratorOutput(loopId: string, generatorSpanId: string | null | undefined) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!generatorSpanId) {
      setText(null);
      return;
    }
    setLoading(true);
    setText(null);
    // Collect candidate revisions; the last assistant one wins.
    let lastAssistant: string | null = null;
    let done = false;
    const ts = typedSource(
      `/api/bff/api/conversations/${loopId}/events?afterSeq=0`,
      conversationEvents,
      { onError: () => {} },
    );
    // History arrives as a burst; close after the burst settles so we don't
    // hold a long-poll open for a one-shot historical read.
    const settle = setTimeout(() => {
      if (!done) {
        done = true;
        ts.close();
        setLoading(false);
        setText(lastAssistant);
      }
    }, 1500);
    ts.on("message", (entry) => {
      if (entry.spanId !== generatorSpanId) return;
      const rev = deserializeLedgerContent(entry.content);
      if ("raw" in rev) return;
      if (rev.role !== "assistant") return;
      const t = extractText({ text: rev.text, blocks: rev.blocks });
      if (t) lastAssistant = t;
    });
    return () => {
      clearTimeout(settle);
      ts.close();
    };
  }, [loopId, generatorSpanId]);

  return { text, loading };
}

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
  const { text: genOutput, loading: genLoading } = useGeneratorOutput(
    loopId,
    item?.generatorSpanId,
  );

  if (!item) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-[var(--mute)]">Select an item to view its evidence chain.</p>
      </div>
    );
  }

  const genRunHref = item.generatorSpanId ? `/work/${loopId}/runs/${item.generatorSpanId}` : null;


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
      {item.generatorSpanId && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Generator Run</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-[var(--mute)]">Span ID</span>
              {genRunHref ? (
                <Link href={genRunHref} className="font-mono text-xs text-blue-600 hover:underline">
                  {item.generatorSpanId}
                </Link>
              ) : (
                <span className="font-mono text-xs">{item.generatorSpanId}</span>
              )}
            </div>
            <div>
              <p className="text-[var(--mute)] mb-1">Agent Output</p>
              {genLoading ? (
                <p className="text-xs text-[var(--mute)] animate-pulse">Loading…</p>
              ) : genOutput ? (
                <pre className="text-sm whitespace-pre-wrap font-sans bg-[var(--canvas)] rounded p-2 border border-[var(--hairline)] max-h-64 overflow-y-auto">
                  {genOutput}
                </pre>
              ) : (
                <p className="text-xs text-[var(--mute)]">No assistant output recorded for this run.</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

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
