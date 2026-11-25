"use client";

import { Download } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConversationPanel } from "@/components/ConversationPanel";
import { Button } from "@/components/ui/button";
import { useAgentList } from "@/features/agents/hooks";
import { ConversationMembers } from "@/features/conversations/ConversationMembers";
import { useConversation } from "@/hooks/useConversation";
import type { ConversationSnapshot } from "@/lib/api";
import { api } from "@/lib/api";
import type { SenderRef } from "@/lib/conversation-reducer";
import { t } from "@/lib/i18n";
import { StatusPill } from "./patterns";
import { RosterList } from "./RosterList";
import { RunDiagnostics } from "./RunDiagnostics";
import { UsagePanel } from "./UsagePanel";

interface ConversationCanvasProps {
  conversationId: string;
  snapshot?: ConversationSnapshot | null;
  initialMessage?: string;
  anchorSeq?: number | null;
}

/** What the header says about the live run, or nothing when it is idle. */
function runLabel(
  isAwaiting: boolean,
  runStatus: string | undefined,
  busy: boolean,
): string | null {
  if (isAwaiting) return "Awaiting approval";
  if (runStatus === "retrying") return "Retrying…";
  if (runStatus === "compacting") return "Compacting context…";
  if (busy) return "Running";
  return null;
}

function agentDisplayName(agent: SenderRef | null): string {
  if (agent === null) return "Agent";
  if (agent.displayName) return agent.displayName;
  if (agent.agentId) return agent.agentId;
  return "Agent";
}

/** The id the backend keys agent-scoped lookups by: it lives on the agent ref, and on `memberId`
 *  for an older snapshot. */
function agentMemberId(agent: SenderRef | null): string | undefined {
  if (agent === null) return undefined;
  if (agent.agentId) return agent.agentId;
  return agent.memberId;
}

export function ConversationCanvas({
  conversationId,
  snapshot,
  initialMessage,
  anchorSeq,
}: ConversationCanvasProps) {
  const router = useRouter();
  const conversation = useConversation(conversationId, snapshot);
  const { state, busy, send, activeRunId } = conversation;
  const { agent } = state;
  // #30: the backend moved this conversation — follow it. The subscription
  // effect re-runs when the route lands on the new conversationId.
  const { continuation } = state;
  // #48: a LIVE ownership transfer auto-follows; a historical continuation
  // (already in the snapshot) only offers a link, so a user can stay and
  // read the old conversation.
  useEffect(() => {
    if (continuation?.live && continuation.control.conversationId !== conversationId) {
      router.replace(`/chat/${continuation.control.conversationId}`);
    }
  }, [continuation, conversationId, router]);

  // W3+W5: use the most recent agent run's status, not first-found.
  // Scan from newest to oldest to get the current run's transient state.
  const isAwaiting = state.items.some(
    (item) =>
      item.kind === "message" && item.sender.kind === "agent" && item.content.state === "waiting",
  );
  const currentRunStatus = (() => {
    for (let i = state.items.length - 1; i >= 0; i--) {
      const item = state.items[i]!;
      if (item.kind === "message" && item.sender.kind === "agent" && item.content.runStatus) {
        return item.content.runStatus;
      }
    }
    return undefined;
  })();
  const label = runLabel(isAwaiting, currentRunStatus, busy);

  // Auto-send the user's first message passed via ?initial= from chat overview.
  const initialSent = useRef(false);
  useEffect(() => {
    if (initialMessage && !initialSent.current) {
      initialSent.current = true;
      send(initialMessage);
      // Clear ?initial= from URL to prevent re-send on refresh.
      router.replace(`/chat/${conversationId}`);
    }
  }, [initialMessage, send, conversationId, router]);

  // The conversation's agent (1:1 collapse — exactly one)
  const primaryAgent = agent;
  const primaryAgentId = agentMemberId(primaryAgent);
  const agentName = agentDisplayName(primaryAgent);

  // Harness badge: agentId → agents.harness (D2/D3). Drives the header badge;
  // every harness (oma/omp/claude/pi) runs through the shared ACP adapter
  // (ADR 0040).
  const { data: agents } = useAgentList();
  const primaryHarness = useMemo(() => {
    if (!primaryAgentId) return undefined;
    return agents?.find((a) => a.id === primaryAgentId)?.harness;
  }, [agents, primaryAgentId]);

  const [exporting, setExporting] = useState(false);
  const handleExport = useCallback(async () => {
    // A click that produces nothing is the worst outcome (a review measured
    // it as "the download icon does nothing"): say so when it fails, and say
    // it is working while the 17-second request runs.
    setExporting(true);
    try {
      const md = await api.exportConversation(conversationId);
      const blob = new Blob([md], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${conversationId}.md`;
      a.rel = "noopener";
      // Firefox only honours a download from an element that is in the document.
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Exported", { description: `${conversationId}.md` });
    } catch (err) {
      const description = err instanceof Error ? err.message : "Unknown error";
      toast.error("Export failed", { description });
    } finally {
      setExporting(false);
    }
  }, [conversationId]);

  // The live Agent Run, as the chat channel reports it (the projection makes the running run the
  // active turn). The /stop target never comes from message state: canonical history has no
  // open runs.
  const currentRunId = activeRunId;

  const stopRun = useCallback(() => {
    if (!currentRunId) return;
    api.cancelAgentRun(currentRunId).then(() => toast.success(t("Stopped")));
  }, [currentRunId]);

  // The room's project (a topic), when it has one. Read without asserting a
  // shape: an older snapshot may predate the field.
  const roomProjectId =
    snapshot !== null &&
    snapshot !== undefined &&
    "projectId" in snapshot &&
    typeof snapshot.projectId === "string" &&
    snapshot.projectId !== ""
      ? snapshot.projectId
      : null;

  const [rosterOpen, setRosterOpen] = useState(false);
  // Page chrome beside the messages: the roster on desktop, its trigger on mobile.
  const rosterAside = (
    <>
      <aside className="hidden md:block shrink-0 w-72 border-l border-(--hairline) overflow-y-auto p-3">
        <RosterList agent={agent} />
        <RunDiagnostics conversationId={conversationId} agentId={primaryAgentId} />
        <UsagePanel conversationId={conversationId} />
      </aside>

      {/* Roster — mobile trigger */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setRosterOpen(true)}
        className="md:hidden"
        aria-expanded={rosterOpen}
        aria-controls="roster-drawer"
      >
        Agent
      </Button>
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-(--canvas)">
      {/* Header */}
      <div className="shrink-0 border-b border-(--hairline) px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2 min-w-0">
              <Link
                href="/chat"
                className="text-[10px] text-(--mute) hover:text-(--body) transition-colors shrink-0"
              >
                Chat
              </Link>
              {primaryAgent && (
                <>
                  <span className="text-(--hairline)">/</span>
                  <span className="text-[10px] text-(--body) truncate">{agentName}</span>
                </>
              )}
            </div>
            <ConversationMembers conversationId={conversationId} />
          </div>
          <div className="flex items-center gap-3 shrink-0 ml-4">
            {primaryAgent?.agentId && (
              // ADR 0073/0076: the room's agent works in its own workspace —
              // and when the ROOM is bound to a project, in that project's
              // worktree. The link carries both so the pane opens on the topic.
              <Link
                href={`/coding?agent=${encodeURIComponent(primaryAgent.agentId)}${
                  roomProjectId === null ? "" : `&project=${encodeURIComponent(roomProjectId)}`
                }`}
                className="text-[10px] tracking-kicker uppercase text-(--mute) hover:text-(--primary) transition-colors"
                title={t("Open a terminal in this conversation's workspace")}
              >
                {t("Terminal")}
              </Link>
            )}
            <Link
              href={`/artifacts?folder=${encodeURIComponent(`tool-images/${conversationId}`)}`}
              className="text-[10px] tracking-kicker uppercase text-(--mute) hover:text-(--primary) transition-colors"
              title={t("Files this conversation produced (screenshots and other tool output)")}
            >
              {t("Artifacts")}
            </Link>
            {label && (
              <>
                <span
                  className={`size-1.5 rounded-full transition-colors duration-500 ${
                    busy ? "animate-dot-pulse bg-(--primary)" : "bg-(--mute)"
                  }`}
                />
                <span
                  className={`text-xs tracking-kicker uppercase font-semibold ${
                    busy ? "text-(--primary)" : "text-(--mute)"
                  }`}
                >
                  {label}
                </span>
              </>
            )}
            {!label && <StatusPill tone="idle">{t("idle")}</StatusPill>}
            {busy && currentRunId && (
              <button
                type="button"
                onClick={stopRun}
                className="rounded-sm border border-(--err)/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-kicker text-(--err) transition-colors hover:bg-(--err)/10"
              >
                {t("stop")}
              </button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7 "
              onClick={handleExport}
              disabled={exporting}
              title={exporting ? t("Exporting…") : t("Export conversation")}
            >
              <Download size={14} />
            </Button>
          </div>
        </div>
        {primaryAgent && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-sm font-medium text-(--ink-strong)">{agentName}</span>
            {primaryHarness && (
              <span className="rounded-sm border border-(--hairline) px-1.5 py-0.5 font-mono text-[10px] text-(--mute)">
                {primaryHarness}
              </span>
            )}
            <span className="font-mono text-[10px] text-(--faint)">{conversationId}</span>
            <span className="mx-1 h-3 w-px bg-(--hairline)" />
            {/* Run-control chips: live binding + status */}
            <span className="rounded-sm border border-(--hairline) bg-(--panel) px-1.5 py-0.5 font-mono text-[10px] text-(--body)">
              conv_store
            </span>
            {busy && label && (
              <>
                <button
                  type="button"
                  onClick={stopRun}
                  className="rounded-sm border border-(--err)/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-kicker text-(--err) transition-colors hover:bg-(--err)/10"
                >
                  abort
                </button>
                <span className="font-mono text-[10px] text-(--primary)">{label}</span>
              </>
            )}
          </div>
        )}
      </div>

      <ConversationPanel
        conversationId={conversationId}
        conversation={conversation}
        anchorSeq={anchorSeq}
        emptyTitle={
          primaryAgent ? (
            <h1 className="font-display text-2xl font-semibold tracking-tight text-(--ink-strong) mb-3">
              {agentName}
            </h1>
          ) : null
        }
        aside={rosterAside}
      />

      {/* Roster — mobile drawer overlay */}
      {rosterOpen && (
        <>
          <div
            className="md:hidden fixed inset-0 bg-black/40 z-40"
            onClick={() => setRosterOpen(false)}
          />
          <aside
            id="roster-drawer"
            className="md:hidden fixed right-0 inset-y-0 w-64 bg-(--canvas) border-l border-(--hairline) z-50 overflow-y-auto p-3 shadow-lg"
            role="dialog"
            aria-label={t("Members")}
          >
            <RosterList agent={agent} onClose={() => setRosterOpen(false)} />
            <RunDiagnostics conversationId={conversationId} agentId={primaryAgentId} />
            <UsagePanel conversationId={conversationId} />
          </aside>
        </>
      )}
    </div>
  );
}
