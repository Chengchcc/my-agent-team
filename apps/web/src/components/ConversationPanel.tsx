"use client";

import { hasDedicatedEvent } from "@chengchenccc/api-contract";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useArtifacts } from "@/features/artifacts/hooks";
import { artifactKeys } from "@/features/artifacts/query-keys";
import type { ConversationController } from "@/hooks/useConversation";
import type { ArtifactMeta } from "@/lib/api";
import { api } from "@/lib/api";
import type { SenderRef, StreamConn } from "@/lib/conversation-reducer";
import { t } from "@/lib/i18n";
import { markRead } from "@/lib/read-seq";
import type { CommandContext, SkillCommand } from "@/lib/slash-commands";
import { findCommand, parseArgs } from "@/lib/slash-commands";
import { connectionStatus } from "@/lib/status";
import { extractText } from "@/lib/timeline";
import type { TodoItem, TransientBubble } from "@/lib/transient-reducer";
import { ArtifactPreviewSheet } from "./ArtifactPreviewSheet";
import { Composer, type RecommendedSkill } from "./Composer";
import { useChatInspector } from "./chat-inspector-context";
import { type ConversationDensity, ConversationDensityContext } from "./conversation-density";
import { Timeline } from "./Timeline";
import { TodoPanel } from "./TodoPanel";

/** The composer's connection badge. The same words the chat page has always shown. */
function connectionBadgeLabel(conn: StreamConn): string {
  if (conn === "reconnecting") return "Reconnecting";
  if (conn === "closed") return "Disconnected";
  return "Connecting";
}
export interface ConversationPanelProps {
  conversationId: string;
  conversation: ConversationController;
  /** `?at=seq`: scroll to the message and flash it. */
  anchorSeq?: number | null;
  /** Heading of the empty state. The chat page names the agent; an embedded view leaves it out. */
  emptyTitle?: ReactNode;
  /** Optional secondary copy under the empty-state heading. */
  emptyDescription?: ReactNode;
  /** Skills the conversation's agent can load, offered in the `/` picker. */
  skills?: readonly SkillCommand[];
  /** Domain skill pinned in the composer bar by default (e.g. /member_manage). */
  recommendedSkill?: RecommendedSkill;
  /** Show clickable skill slash-command chips in the composer by default. */
  showSkillChips?: boolean;
  /** A draft put into the composer while it is empty, for the person to edit and send. */
  draft?: string;
  /** Whether showing this conversation counts as the person having seen it. The chat page says
   *  yes; a panel embedded beside something else says no, so opening that other thing does not
   *  clear unread marks. */
  marksSeen?: boolean;
  /** Page chrome that belongs beside the messages — the chat page's roster. */
  aside?: ReactNode;
  /** The scale this conversation runs at: the page's, or the tighter one of a side sheet. */
  density?: ConversationDensity;
}

/** The content of one conversation: messages, live state and the composer. Everything here is
 *  keyed by the real conversation, so the chat page, a side sheet and an embedded view show the
 *  same messages, model and input queue. Page chrome (header, roster, diagnostics) stays with
 *  the page. */
export function ConversationPanel({
  conversationId,
  conversation,
  anchorSeq,
  emptyTitle,
  emptyDescription,
  skills,
  recommendedSkill,
  showSkillChips,
  draft,
  marksSeen = true,
  aside,
  density = "page",
}: ConversationPanelProps) {
  const router = useRouter();
  const inspector = useChatInspector();
  const {
    state,
    busy,
    send,
    transients,
    transientTools,
    runTodos,
    activeRunId,
    resolveApproval,
    markUndone,
  } = conversation;
  const { agent, items, error, streamConn, continuation } = state;
  // Seeing the conversation marks it read: covers deep links and messages
  // that arrive while the panel is open (the sidebar dot clears too). A view
  // that merely shows a conversation beside something else does not count as
  // seeing it: opening an editor must not clear that conversation's unread
  // marks or its attention debts.
  const maxSeenSeq = useMemo(
    () => items.reduce((max, item) => Math.max(max, item.kind === "message" ? item.seq : 0), 0),
    [items],
  );
  useEffect(() => {
    if (!marksSeen) return;
    if (maxSeenSeq > 0) markRead(conversationId, maxSeenSeq);
    // ADR 0061: the same look clears the backend's attention debts for this
    // conversation (a pending question, an unseen terminal notice). It only
    // advances read marks - it cannot change what a run did.
    void api.markSeen({ conversationId }).catch(() => {});
  }, [conversationId, maxSeenSeq, marksSeen]);

  const { data: artifactsData } = useArtifacts();
  const artifactsByRunId = useMemo(() => {
    const map = new Map<string, ArtifactMeta[]>();
    for (const a of artifactsData?.artifacts ?? []) {
      if (a.source?.runId) {
        const list = map.get(a.source.runId) ?? [];
        list.push(a);
        map.set(a.source.runId, list);
      }
    }
    return map;
  }, [artifactsData]);

  // Refresh artifacts after a run settles so the session panel picks up
  // newly uploaded outputs without a page reload.
  const qc = useQueryClient();
  const wasBusy = useRef(false);

  useEffect(() => {
    if (wasBusy.current && !busy) {
      qc.invalidateQueries({ queryKey: artifactKeys.all });
    }
    wasBusy.current = busy;
  }, [busy, qc]);

  const [previewArtifact, setPreviewArtifact] = useState<ArtifactMeta | null>(null);

  async function handleDownloadArtifact(a: ArtifactMeta) {
    try {
      const r = await api.downloadArtifact(a.url);
      const blob =
        r.encoding === "base64"
          ? new Blob([Uint8Array.from(atob(r.content), (c) => c.charCodeAt(0))], {
              type: r.mimeType,
            })
          : new Blob([r.content], { type: r.mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = a.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(`Failed to download artifact: ${String(e)}`);
    }
  }

  const lastUserMessage = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const entry = items[i]!;
      if (entry.kind !== "message") continue;
      if (entry.sender.kind === "human") return extractText(entry.content);
    }
    return null;
  }, [items.length, items]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(items.length);
  const transientTextLen = useMemo(
    () => Object.values(transients).reduce((n, t) => n + t.text.length, 0),
    [transients],
  );
  const [scrolledUp, setScrolledUp] = useState(false);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const [starterDraft, setStarterDraft] = useState<string | undefined>(undefined);

  useEffect(() => {
    const grew = items.length > prevLen.current;
    prevLen.current = items.length;
    if (grew) {
      if (!scrolledUp && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      } else if (scrolledUp) {
        setHasNewBelow(true);
      }
    }
    // Streaming bubbles grow without changing items.length — follow them only when pinned to bottom.
    if (transientTextLen > 0 && !scrolledUp && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items.length, transientTextLen, scrolledUp]);

  // One timeline bubble per active run, addressed via its agent member.
  const transientBubbles = useMemo(() => {
    const bubbles: TransientBubble[] = [];
    for (const [runId, t] of Object.entries(transients)) {
      const sender = agent ?? { memberId: t.agentId, kind: "agent" as const, agentId: t.agentId };
      bubbles.push({
        ...t,
        runId,
        sender,
        tools: Object.values(transientTools).filter(
          (tool) => tool.runId === runId && !hasDedicatedEvent(tool.name),
        ),
      });
    }
    return bubbles;
  }, [transients, transientTools, agent]);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
      setHasNewBelow(false);
    }
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setScrolledUp(!atBottom);
    if (atBottom) setHasNewBelow(false);
  }, []);

  // Cmd+K ?at=seq: scroll to the message and flash-highlight it.
  useEffect(() => {
    if (anchorSeq == null || !scrollRef.current) return;
    // Messages render with data-seq attributes via Timeline's MessageActions.
    // Try a few selectors to find the target element.
    const el = document.querySelector(`[data-seq="${anchorSeq}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-[var(--primary)]/50", "rounded-lg");
      const timeout = setTimeout(() => {
        el.classList.remove("ring-2", "ring-[var(--primary)]/50", "rounded-lg");
      }, 2000);
      return () => clearTimeout(timeout);
    }
  }, [anchorSeq]);

  // The live Agent Run, as the chat channel reports it (the projection makes the running run the
  // active turn). The /stop target never comes from message state: canonical history has no
  // open runs.
  const currentRunId = activeRunId;

  const stopRun = useCallback(() => {
    if (currentRunId) api.cancelAgentRun(currentRunId).then(() => toast.success(t("Stopped")));
  }, [currentRunId]);

  const handleSlashCommand = useCallback(
    async (input: string) => {
      const cmd = findCommand(input);
      if (!cmd) {
        // Unknown command, a skill name included: send as a normal message.
        send(input);
        return;
      }
      const args = parseArgs(input);
      const ctx: CommandContext = {
        conversationId,
        args,
        toast: (msg, type) =>
          type === "error"
            ? toast.error(msg)
            : type === "info"
              ? toast.info(msg)
              : toast.success(msg),
        currentRunId,
        router: { push: router.push },
      };
      await cmd.execute(ctx);
    },
    [conversationId, send, currentRunId, router],
  );

  return (
    <ConversationDensityContext value={density}>
      {/* SSE connection warning — sticky alert until the stream recovers */}
      {(streamConn === "reconnecting" || streamConn === "closed") && (
        <div
          role="alert"
          className={`sticky top-0 z-30 shrink-0 px-6 py-1.5 flex items-center gap-2 text-xs ${
            streamConn === "closed" ? "bg-(--err)/15 text-(--err)" : "bg-(--warn)/15 text-(--warn)"
          }`}
        >
          <span
            className={`size-1.5 rounded-full animate-pulse ${
              streamConn === "closed" ? "bg-(--err)" : "bg-(--warn)"
            }`}
          />
          <span className="flex-1">{connectionStatus(streamConn).label}</span>
          {streamConn === "closed" && (
            <Button
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => window.location.reload()}
            >
              Reconnect
            </Button>
          )}
        </div>
      )}

      {/* M14.6: Todo progress — pinned above message stream */}
      <TodoPanel
        runs={Object.entries(runTodos)
          .map(([runId, items]) => ({
            runId,
            agent: agent ?? null,
            items,
          }))
          .filter(
            (r): r is { runId: string; agent: SenderRef; items: readonly TodoItem[] } =>
              r.agent !== null,
          )}
      />

      {/* Error bar */}
      {error && (
        <div className="shrink-0 border-b border-(--hairline) bg-(--canvas-soft) px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-1 h-4 bg-(--primary)/60 shrink-0 rounded-full" />
            <p className="text-xs text-(--ink)">{error}</p>
          </div>
          {lastUserMessage && (
            <Button
              onClick={() => send(lastUserMessage)}
              className="text-xs text-(--primary) hover:text-(--primary-deep) transition-colors shrink-0 ml-4"
            >
              Retry
            </Button>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Left column: timeline canvas + composer live together as one cohesive chat surface */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Main scroll area */}
          <div ref={scrollRef} onScroll={handleScroll} className="flex-1 min-w-0 overflow-y-auto">
            <div className="mx-auto max-w-[min(760px,100%)] w-full p-6 pb-28">
              {items.length === 0 && streamConn !== "open" ? (
                // The subscription is the history. Until its first snapshot
                // arrives "start the conversation" is a claim about a room we
                // have not read yet — the console said it for ten seconds on a
                // room with 400 messages (audit 2026-11-24).
                <p className="px-1 py-8 text-sm text-(--mute)">{t("Loading…")}</p>
              ) : items.length === 0 ? (
                <div className="mx-auto flex max-w-md flex-col items-center justify-center py-24 text-center">
                  {emptyTitle}
                  {emptyDescription && (
                    <p className="mt-1.5 text-xs leading-relaxed text-(--mute)">
                      {emptyDescription}
                    </p>
                  )}
                  {!emptyDescription && (
                    <p className="mt-1 text-sm text-(--mute)">
                      {t("Send a message to start the conversation")}
                    </p>
                  )}
                  {skills && skills.length > 0 && (
                    <div className="mt-5 flex flex-wrap justify-center gap-1.5">
                      {skills.slice(0, 4).map((skill) => (
                        <button
                          key={skill.command}
                          type="button"
                          onClick={() => setStarterDraft(`${skill.command} `)}
                          title={skill.description}
                          className="inline-flex items-center gap-1.5 rounded-full border border-(--hairline) bg-(--panel)/70 px-3 py-1 font-mono text-[11px] text-(--body) transition-colors hover:border-(--primary)/45 hover:bg-(--panel) hover:text-(--ink)"
                        >
                          {skill.command}
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="mt-4 font-mono text-[10px] text-(--faint)">
                    {t("Enter to send · Shift+Enter for newline · / for commands")}
                  </p>
                </div>
              ) : (
                <div className="py-4">
                  {continuation && !continuation.live ? (
                    <button
                      type="button"
                      onClick={() => router.push(`/chat/${continuation.control.conversationId}`)}
                      className="mb-3 rounded-md border border-(--hairline) px-3 py-2 text-xs text-(--mute) hover:text-(--fg) hover:border-(--fg)"
                    >
                      This conversation continued in a new one — open it →
                    </button>
                  ) : null}
                  <Timeline
                    messages={items}
                    conversationId={conversationId}
                    scrollContainerRef={scrollRef}
                    transients={transientBubbles}
                    onResolveApproval={resolveApproval}
                    onMarkUndone={markUndone}
                    onResolveAsk={(runId, callId, answer) => {
                      void api.resolveProductAsk({
                        runId,
                        callId,
                        answer: answer as {
                          answers: Array<{
                            id: string;
                            selectedValues: string[];
                            freeText?: string;
                          }>;
                        },
                      });
                    }}
                    artifactsByRunId={artifactsByRunId}
                    onPreviewArtifact={(art) => {
                      if (inspector) {
                        inspector.openArtifact(art);
                        return;
                      }
                      setPreviewArtifact(art);
                    }}
                    onDownloadArtifact={handleDownloadArtifact}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Scroll-to-bottom — floats cleanly above the docked composer */}
          {scrolledUp && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={scrollToBottom}
              className="absolute bottom-28 left-1/2 z-20 h-7 -translate-x-1/2 gap-1.5 rounded-full border-(--hairline-soft) bg-(--panel)/95 px-3 text-[11px] text-(--ink) backdrop-blur hover:border-(--primary)/60"
              title={t("Back to bottom")}
            >
              <ArrowDown size={13} className="text-(--primary)" />
              <span>{hasNewBelow ? t("New messages") : t("Jump to latest")}</span>
            </Button>
          )}

          {/* Composer — docked cleanly at the bottom with soft gradient fade */}
          <div className="relative shrink-0 bg-(--canvas)">
            <div
              className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-linear-to-t from-(--canvas) to-transparent"
              aria-hidden
            />
            {streamConn !== "open" && (
              <div className="mx-auto flex max-w-[min(760px,100%)] items-center gap-2 px-6 pt-1">
                <Badge
                  variant={streamConn === "closed" ? "destructive" : "secondary"}
                  className="ml-auto h-4 px-1.5 text-[10px]"
                >
                  {connectionBadgeLabel(streamConn)}
                </Badge>
              </div>
            )}
            <Composer
              conversationId={conversationId}
              onSend={send}
              onSlashCommand={handleSlashCommand}
              disabled={false}
              placeholder={busy ? t("Steer or queue a follow-up…") : t("Ask anything…")}
              isBusy={busy}
              onStop={currentRunId ? stopRun : undefined}
              skills={skills}
              recommendedSkill={recommendedSkill}
              showSkillChips={showSkillChips}
              draft={draft ?? starterDraft}
            />
          </div>
        </div>

        {/* Right column: full-height context or Antigravity-style artifact/requirement preview */}
        {aside}
      </div>

      {!inspector && (
        <ArtifactPreviewSheet
          artifact={previewArtifact}
          onClose={() => setPreviewArtifact(null)}
          conversationId={conversationId}
        />
      )}
    </ConversationDensityContext>
  );
}
