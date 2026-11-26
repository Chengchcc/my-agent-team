"use client";

import { Download } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ConversationPanel } from "@/components/ConversationPanel";
import { Button } from "@/components/ui/button";
import { RoleAvatar, roleKindOf } from "@/components/ui/role-avatar";
import { useAgentList } from "@/features/agents/hooks";
import { useConversationTitle } from "@/features/conversations/hooks";
import { useConversation } from "@/hooks/useConversation";
import type { ConversationSnapshot } from "@/lib/api";
import { api } from "@/lib/api";
import type { SenderRef } from "@/lib/conversation-reducer";
import { conversationDisplayName } from "@/lib/conversation-title";
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

  const primaryAgent = agent;
  const primaryAgentId = agentMemberId(primaryAgent);
  const agentName = agentDisplayName(primaryAgent);

  const { data: agents } = useAgentList();
  const member = agents?.find((a) => a.id === primaryAgentId);
  const primaryHarness = member?.harness;
  const mark = roleKindOf({ name: agentName, role: member?.role });

  const { data: titleRow } = useConversationTitle(conversationId);
  const title = titleRow ? conversationDisplayName(titleRow) : agentName;

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

  // The live Agent Run, as the chat channel reports it. The /stop target never comes from
  // message state: canonical history has no open runs.
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

  const [rosterOpen, setRosterOpen] = useState<"" | "open">("");
  const rosterOpenNow = rosterOpen === "open";

  // Beside the messages: who the PA is, then the room's members and diagnostics.
  const rosterAside = (
    <>
      <aside className="hidden w-[300px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-(--hairline) p-5 md:flex">
        <section className="rounded-[15px] border border-white/6 bg-(--panel) p-5">
          <h2 className="mb-3 text-sm font-[550] text-(--ink)">{t("Source and current PA")}</h2>
          <div className="flex items-center gap-2.5 rounded-[11px] border border-(--hairline) p-3">
            <RoleAvatar kind={mark} name={agentName} />
            <div className="min-w-0">
              <strong className="block text-xs text-(--ink)">{agentName}</strong>
              <small className="mt-1 block text-[10px] text-(--mute)">
                {primaryHarness === undefined ? t("Agent") : primaryHarness}
                {" · "}
                {conversationId}
              </small>
            </div>
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-(--faint)">
            {t("The main session is between you and the PA. Workers run in their own sessions.")}
          </p>
        </section>
        <section className="rounded-[15px] border border-white/6 bg-(--panel) p-5">
          <h2 className="mb-3 text-sm font-[550] text-(--ink)">{t("Members")}</h2>
          <RosterList agent={agent} />
          <RunDiagnostics conversationId={conversationId} agentId={primaryAgentId} />
          <UsagePanel conversationId={conversationId} />
        </section>
      </aside>

      <Button
        variant="outline"
        size="sm"
        onClick={() => setRosterOpen("open")}
        className="md:hidden"
        aria-expanded={rosterOpenNow}
        aria-controls="roster-drawer"
      >
        {t("Members")}
      </Button>
    </>
  );

  const terminalHref = `/coding?agent=${encodeURIComponent(primaryAgentId ?? "")}${
    roomProjectId === null ? "" : `&project=${encodeURIComponent(roomProjectId)}`
  }&locate=1`;
  const folder = ["tool-images", conversationId].join("/");
  const artifactsHref = `/artifacts?folder=${encodeURIComponent(folder)}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-(--canvas)">
      {/* Page head: source, title, who is on the other side, and the room's actions */}
      <div className="shrink-0 px-6 pt-7 sm:px-[38px]">
        <div className="flex flex-wrap items-center justify-between gap-5 pb-[29px]">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <RoleAvatar kind={mark} name={agentName} />
              <p className="text-[10px] tracking-[1.8px] uppercase text-(--faint)">
                {t("Work session")}
              </p>
            </div>
            <h1 className="mt-2 truncate text-[29px] leading-[1.4] font-[550] tracking-[-1px] text-(--ink)">
              {title}
            </h1>
            <p className="mt-0.5 text-xs text-(--mute)">{agentName}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {label ? (
              <>
                <span
                  className={`size-1.5 rounded-full transition-colors duration-500 ${
                    busy ? "animate-dot-pulse bg-(--primary)" : "bg-(--mute)"
                  }`}
                />
                <span className="text-[10px] uppercase tracking-[1.8px] text-(--mute)">
                  {label}
                </span>
              </>
            ) : (
              <StatusPill tone="idle">{t("idle")}</StatusPill>
            )}
            {busy && currentRunId && (
              <Button variant="destructive" size="sm" onClick={stopRun}>
                {t("stop")}
              </Button>
            )}
            {primaryAgentId && (
              // ADR 0073/0076: the room's agent works in its own workspace — and when the ROOM is
              // bound to a project, in that project's worktree. `locate` only focuses a workbench
              // that already exists; it never starts a terminal behind the person's back.
              <Button size="sm" variant="outline" render={<Link href={terminalHref} />}>
                {t("Terminal")}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              render={<Link href={artifactsHref} />}
              title={t("Files this conversation produced (screenshots and other tool output)")}
            >
              {t("Artifacts")}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleExport}
              disabled={exporting}
              title={exporting ? t("Exporting…") : t("Export conversation")}
            >
              <Download size={14} />
            </Button>
          </div>
        </div>
      </div>

      <ConversationPanel
        conversationId={conversationId}
        conversation={conversation}
        anchorSeq={anchorSeq}
        emptyTitle={
          primaryAgent ? (
            <p className="mb-2 text-sm text-(--mute)">
              {t("Send a message to start the conversation")}
            </p>
          ) : null
        }
        aside={rosterAside}
      />

      {/* Members — mobile drawer overlay */}
      {rosterOpenNow && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={() => setRosterOpen("")}
          />
          <aside
            id="roster-drawer"
            className="fixed inset-y-0 right-0 z-50 w-72 overflow-y-auto border-l border-(--hairline) bg-(--panel) p-4 shadow-lg md:hidden"
            role="dialog"
            aria-label={t("Members")}
          >
            <RosterList agent={agent} onClose={() => setRosterOpen("")} />
            <RunDiagnostics conversationId={conversationId} agentId={primaryAgentId} />
            <UsagePanel conversationId={conversationId} />
          </aside>
        </>
      )}
    </div>
  );
}
