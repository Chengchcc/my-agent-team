"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useState } from "react";
import { RunWaterfall } from "@/components/ops/RunWaterfall";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useAgentList } from "@/features/agents/hooks";
import { useAgentRunDetail, useAgentRuns } from "@/features/ops/hooks";
import { api } from "@/lib/api";

export const dynamic = "force-dynamic";

export default function SystemRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const searchParams = useSearchParams();
  const from = searchParams.get("from");

  const detailQuery = useAgentRunDetail(runId);
  const run = detailQuery.data?.run;
  const inputs = detailQuery.data?.inputs ?? [];
  // ADR 0066: the "shop floor" hop. A Lark card links to this run (the front
  // desk's turn); the units it dispatched are the next step down, and each
  // links to its own page.
  const childrenQuery = useAgentRuns({ parentRunId: runId, limit: 50 });
  const children = childrenQuery.data?.runs ?? [];
  const { data: agents } = useAgentList();
  const nameOf = (agentId: string) => agents?.find((a) => a.id === agentId)?.name ?? agentId;
  // ADR 0066 D4: the shop floor is where you can talk to the worker directly.
  // Only workers get the box - the front desk is talked to in the room.
  const isWorker = agents?.find((a) => a.id === run?.agentId)?.role === "worker";
  const [floorText, setFloorText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  async function sendFloor() {
    if (!run || floorText.trim() === "") return;
    setSending(true);
    try {
      await api.postFloorMessage({
        conversationId: run.conversationId,
        agentId: run.agentId,
        text: floorText.trim(),
      });
      setFloorText("");
      setSent("Sent. The room keeps a one-line note about who you talked to.");
    } catch (error) {
      setSent(error instanceof Error ? error.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={
          from ? (
            <Link href={from} className="text-(--info) hover:underline">
              ← Back to conversation
            </Link>
          ) : (
            "System / Runs"
          )
        }
        title={run ? run.runId.slice(0, 12) : runId.slice(0, 12)}
        action={run ? <Badge>{run.status}</Badge> : undefined}
      />
      <PageBody className="space-y-6">
        {detailQuery.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {detailQuery.error && <p className="text-sm text-destructive">Failed to load run detail</p>}

        {run && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Run</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-xs text-(--mute)">Conversation</span>
                  <div>{run.conversationId}</div>
                </div>
                <div>
                  <span className="text-xs text-(--mute)">Member</span>
                  <div>{run.agentId}</div>
                </div>
                <div>
                  <span className="text-xs text-(--mute)">Conversation</span>
                  <Link
                    href={`/chat/${run.conversationId}`}
                    className="text-xs text-(--info) underline"
                  >
                    Open conversation
                  </Link>
                </div>
                <div>
                  <span className="text-xs text-(--mute)">Model</span>
                  <div>{run.model.harness ?? run.model.modelId.replace(/^acp\//, "")}</div>
                </div>
                <div>
                  <span className="text-xs text-(--mute)">Created</span>
                  <div>{new Date(run.createdAt).toLocaleString()}</div>
                </div>
                {run.usage && (
                  <div>
                    <span className="text-xs text-(--mute)">Usage</span>
                    <div>{(run.usage.inputTokens ?? 0) + (run.usage.outputTokens ?? 0)} tok</div>
                  </div>
                )}
                {run.usage?.costUsd != null && (
                  <div>
                    <span className="text-xs text-(--mute)">Cost</span>
                    <div>${run.usage.costUsd.toFixed(4)}</div>
                  </div>
                )}
                {run.terminalResult &&
                  "error" in run.terminalResult &&
                  run.terminalResult.error && (
                    <div className="col-span-2">
                      <span className="text-xs text-(--mute)">Error</span>
                      <div className="font-mono text-xs text-red-400">
                        {run.terminalResult.error}
                      </div>
                    </div>
                  )}
              </CardContent>
            </Card>

            {isWorker ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Talk to this worker</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-xs text-(--mute)">
                    A floor visit: your words reach it directly, and the room gets a one-line note
                    saying who you were talking to.
                  </p>
                  <Textarea
                    value={floorText}
                    onChange={(e) => setFloorText(e.target.value)}
                    placeholder="Say it as you would to a colleague…"
                    rows={3}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={sending || floorText.trim() === ""}
                      onClick={() => void sendFloor()}
                    >
                      {sending ? "Sending…" : "Send to worker"}
                    </Button>
                    {sent ? <span className="text-xs text-(--mute)">{sent}</span> : null}
                  </div>
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Dispatched units</CardTitle>
              </CardHeader>
              <CardContent>
                {children.length === 0 ? (
                  <p className="text-sm text-(--mute)">
                    This run dispatched nobody; it is the work itself.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {children.map((c) => (
                      <div
                        key={c.runId}
                        className="flex items-center justify-between gap-2 border-b border-(--hairline) py-1 text-sm"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate">{nameOf(c.agentId)}</span>
                          <Badge variant="secondary" className="text-[10px]">
                            {c.status}
                          </Badge>
                        </span>
                        <span className="flex items-center gap-3">
                          <span className="text-xs text-(--mute)">
                            {new Date(c.createdAt).toLocaleString()}
                          </span>
                          <Link
                            href={`/system/runs/${c.runId}`}
                            className="text-xs text-(--info) underline"
                          >
                            Open
                          </Link>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Phase waterfall</CardTitle>
              </CardHeader>
              <CardContent>
                <RunWaterfall
                  runId={run.runId}
                  startTs={run.createdAt}
                  endTs={run.terminalAt ?? null}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Queued inputs</CardTitle>
              </CardHeader>
              <CardContent>
                {inputs.length === 0 ? (
                  <p className="text-sm text-(--mute)">No queued inputs.</p>
                ) : (
                  <div className="space-y-1">
                    {inputs.map((i) => (
                      <div
                        key={i.inputId}
                        className="flex items-center justify-between text-sm border-b border-(--hairline) py-1"
                      >
                        <span>
                          {i.mode} · {i.status}
                        </span>
                        <span className="text-xs text-(--mute)">
                          {new Date(i.createdAt).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </PageBody>
    </Page>
  );
}
