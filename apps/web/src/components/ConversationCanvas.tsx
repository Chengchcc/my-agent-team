"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  Download,
  FileText,
  FolderOpen,
  PanelRight,
  PanelRightClose,
  Target,
  Terminal,
  Workflow,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { ChatSidePreviewPane } from "@/components/ChatSidePreviewPane";
import { ConversationPanel } from "@/components/ConversationPanel";
import {
  ChatInspectorContext,
  type ChatInspectorTarget,
} from "@/components/chat-inspector-context";
import { fmtBytes } from "@/components/ops/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EntityLink } from "@/components/ui/entity-link";
import { RoleAvatar, roleKindOf } from "@/components/ui/role-avatar";
import { useAgentList } from "@/features/agents/hooks";
import { useArtifacts } from "@/features/artifacts/hooks";
import { useCodingTerminals } from "@/features/coding/hooks";
import { useConversationTitle } from "@/features/conversations/hooks";
import { useProjectList } from "@/features/projects/hooks";
import { requirementsQuery } from "@/features/requirements/queries";
import { agentSkillCommandsQuery } from "@/features/skill-packs/queries";
import { filteredWorkflowExecutionsQuery } from "@/features/workflow/queries";
import { useConversation } from "@/hooks/useConversation";
import type { ArtifactMeta, ConversationSnapshot } from "@/lib/api";
import { api } from "@/lib/api";
import type { SenderRef } from "@/lib/conversation-reducer";
import { conversationDisplayName } from "@/lib/conversation-title";
import { t } from "@/lib/i18n";
import type { SkillCommand } from "@/lib/slash-commands";
import { executionStatus } from "@/lib/status";
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
  const { agent, continuation } = state;

  useEffect(() => {
    if (continuation?.live && continuation.control.conversationId !== conversationId) {
      router.replace(`/chat/${continuation.control.conversationId}`);
    }
  }, [continuation, conversationId, router]);

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

  const initialSent = useRef(false);
  useEffect(() => {
    if (initialMessage && !initialSent.current) {
      initialSent.current = true;
      send(initialMessage);
      router.replace(`/chat/${conversationId}`);
    }
  }, [initialMessage, send, conversationId, router]);

  const primaryAgent = agent;
  const primaryAgentId = agentMemberId(primaryAgent);

  const { data: agents } = useAgentList();
  const { data: projectsData } = useProjectList();
  const member = agents?.find((a) => a.id === primaryAgentId);
  const agentName = member?.name ?? agentDisplayName(primaryAgent);
  const primaryHarness = member?.harness;
  const mark = roleKindOf({ name: agentName, role: member?.role });

  const skillsQuery = useQuery({
    ...agentSkillCommandsQuery(primaryAgentId ?? ""),
    enabled: Boolean(primaryAgentId),
  });
  const skills: readonly SkillCommand[] = skillsQuery.data ?? [];

  const { data: titleRow } = useConversationTitle(conversationId);
  const title = titleRow ? conversationDisplayName(titleRow) : agentName;
  const currentRequirementId =
    titleRow &&
    "currentRequirementId" in titleRow &&
    typeof titleRow.currentRequirementId === "string"
      ? titleRow.currentRequirementId
      : null;

  // ADR 0082 D7: real session context (linked requirements, produced artifacts, terminals, workflows).
  const reqsQuery = useQuery(requirementsQuery({ conversationId }));
  const artifactsQuery = useArtifacts({ conversationId });
  const terminalsQuery = useCodingTerminals();
  const workflowsQuery = useQuery(filteredWorkflowExecutionsQuery({ conversationId }));

  const sessionRequirements = reqsQuery.data?.requirements ?? [];
  const sessionArtifacts = artifactsQuery.data?.artifacts ?? [];
  const sessionTerminals = (terminalsQuery.data?.terminals ?? []).filter(
    (item) => item.conversationId === conversationId,
  );
  const sessionExecutions = workflowsQuery.data?.executions ?? [];

  const [inspectorTarget, setInspectorTarget] = useState<ChatInspectorTarget | null>(null);
  // Antigravity / Codex layout: keep the conversation calm and centered by default;
  // right-hand context/preview opens on demand (or automatically when clicking an
  // artifact / requirement chip) and supports drag-to-resize.
  const [asideVisible, setAsideVisible] = useState(false);
  const [asideWidth, setAsideWidth] = useState<number>(360);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const draggingRef = useRef(false);

  const startResize = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const next = Math.min(720, Math.max(320, window.innerWidth - ev.clientX));
      setAsideWidth(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const openArtifact = useCallback((artifact: ArtifactMeta) => {
    setInspectorTarget({ kind: "artifact", artifact });
    setAsideWidth((w) => Math.max(w, 480));
    setAsideVisible(true);
  }, []);

  const openRequirement = useCallback((requirementId: string) => {
    setInspectorTarget({ kind: "requirement", requirementId });
    setAsideWidth((w) => Math.max(w, 480));
    setAsideVisible(true);
  }, []);

  const closePreview = useCallback(() => {
    setInspectorTarget(null);
  }, []);

  const inspectorController = useMemo(
    () => ({
      active: inspectorTarget,
      openArtifact,
      openRequirement,
      closePreview,
    }),
    [inspectorTarget, openArtifact, openRequirement, closePreview],
  );

  const [exporting, setExporting] = useState(false);
  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const md = await api.exportConversation(conversationId);
      const blob = new Blob([md], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${conversationId}.md`;
      a.rel = "noopener";
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

  const currentRunId = activeRunId;
  const stopRun = useCallback(() => {
    if (!currentRunId) return;
    api.cancelAgentRun(currentRunId).then(() => toast.success(t("Stopped")));
  }, [currentRunId]);

  const roomProjectId =
    (titleRow?.projectId ??
      (snapshot !== null &&
      snapshot !== undefined &&
      "projectId" in snapshot &&
      typeof snapshot.projectId === "string" &&
      snapshot.projectId !== ""
        ? snapshot.projectId
        : null)) ||
    null;
  const projectById = new Map(
    (projectsData?.projects ?? []).map((p) => [p.projectId, p.name] as const),
  );
  const roomProjectName = roomProjectId ? (projectById.get(roomProjectId) ?? null) : null;

  const terminalParams = new URLSearchParams({ locate: "1", conversation: conversationId });
  if (primaryAgentId) terminalParams.set("agent", primaryAgentId);
  if (roomProjectId) terminalParams.set("project", roomProjectId);
  if (currentRequirementId) terminalParams.set("requirement", currentRequirementId);
  const terminalHref = `/coding?${terminalParams.toString()}`;
  const artifactsHref = `/artifacts?conversation=${encodeURIComponent(conversationId)}`;
  const requirementsHref = `/requirements?conversation=${encodeURIComponent(conversationId)}`;

  // ADR 0082 D7: replace the redundant 1:1 Members card with live Session Context.
  const contextPanels = (
    <div className="flex flex-col gap-4">
      <section className="rounded-[15px] border border-white/6 bg-(--panel) p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-xs font-[550] text-(--ink-strong)">
            <Target className="size-3.5 text-(--primary)" />
            {t("Linked goals")}
          </h2>
          <span className="font-mono text-[10px] text-(--faint)">{sessionRequirements.length}</span>
        </div>
        {sessionRequirements.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-(--mute)">
            {t("No goal linked to this conversation yet.")}
          </p>
        ) : (
          <ul className="space-y-2">
            {sessionRequirements.slice(0, 5).map((req) => {
              const isCurrent = req.requirementId === currentRequirementId;
              const pName = req.projectId ? projectById.get(req.projectId) : undefined;
              return (
                <li
                  key={req.requirementId}
                  className="rounded-lg border border-(--hairline) bg-(--canvas-soft)/60 p-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => openRequirement(req.requirementId)}
                      className="min-w-0 flex-1 truncate text-left text-xs font-medium text-(--ink) hover:text-(--primary)"
                      title={req.title}
                    >
                      {req.title}
                    </button>
                    {isCurrent && <Badge variant="default">{t("Current goal")}</Badge>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-(--mute)">
                    {req.goal}
                  </p>
                  {pName && (
                    <span className="mt-1.5 inline-block font-mono text-[10px] text-(--faint)">
                      {pName}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3 border-t border-(--hairline) pt-2.5">
          <Link
            href={requirementsHref}
            className="inline-flex items-center gap-1 text-[11px] text-(--primary-deep) hover:text-(--primary)"
          >
            {t("View in Requirements")} <ArrowUpRight className="size-3" />
          </Link>
        </div>
      </section>

      <section className="rounded-[15px] border border-white/6 bg-(--panel) p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-xs font-[550] text-(--ink-strong)">
            <FolderOpen className="size-3.5 text-(--primary)" />
            {t("Session artifacts")}
          </h2>
          <span className="font-mono text-[10px] text-(--faint)">{sessionArtifacts.length}</span>
        </div>
        {sessionArtifacts.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-(--mute)">
            {t("Files produced in this session appear here for quick preview.")}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {sessionArtifacts.slice(0, 5).map((art) => (
              <li key={art.url}>
                <button
                  type="button"
                  onClick={() => openArtifact(art)}
                  className="flex w-full items-center gap-2 rounded-lg border border-(--hairline) bg-(--canvas-soft)/50 px-2.5 py-2 text-left transition-colors hover:border-(--primary)/40"
                >
                  <FileText className="size-3.5 shrink-0 text-(--mute)" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-(--ink)">
                      {art.filename}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-(--faint)">
                      {art.folder} · {fmtBytes(art.size)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 border-t border-(--hairline) pt-2.5">
          <Link
            href={artifactsHref}
            className="inline-flex items-center gap-1 text-[11px] text-(--primary-deep) hover:text-(--primary)"
          >
            {t("Open in Artifacts")} <ArrowUpRight className="size-3" />
          </Link>
        </div>
      </section>

      {(roomProjectId !== null || sessionTerminals.length > 0 || sessionExecutions.length > 0) && (
        <section className="rounded-[15px] border border-white/6 bg-(--panel) p-4 space-y-3">
          <h2 className="text-xs font-[550] text-(--ink-strong)">{t("Workbench & flows")}</h2>
          {roomProjectId && (
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-(--mute)">{t("Project")}</span>
              <EntityLink
                kind="project"
                id={roomProjectId}
                label={roomProjectName}
                href={`/team/projects/${encodeURIComponent(roomProjectId)}`}
              />
            </div>
          )}
          {sessionTerminals.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-[0.8px] text-(--faint)">
                {t("Coding")} · {sessionTerminals.length}
              </p>
              {sessionTerminals.slice(0, 3).map((term) => (
                <Link
                  key={term.terminalId}
                  href={`/coding?locate=1&conversation=${encodeURIComponent(conversationId)}&t=${encodeURIComponent(term.terminalId)}`}
                  className="flex items-center gap-2 rounded-lg border border-(--hairline) px-2.5 py-1.5 text-xs text-(--ink) hover:border-(--primary)/40 hover:text-(--primary)"
                >
                  <Terminal className="size-3.5 shrink-0 text-(--mute)" />
                  <span className="min-w-0 flex-1 truncate">{term.title}</span>
                  <span className="font-mono text-[10px] text-(--faint)">{term.status}</span>
                </Link>
              ))}
            </div>
          )}
          {sessionExecutions.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-[0.8px] text-(--faint)">
                {t("Workflows")} · {sessionExecutions.length}
              </p>
              {sessionExecutions.slice(0, 3).map((exec) => (
                <Link
                  key={exec.executionId}
                  href={`/workflows/${encodeURIComponent(exec.workflowId)}/executions/${encodeURIComponent(exec.executionId)}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-(--hairline) px-2.5 py-1.5 text-xs text-(--ink) hover:border-(--primary)/40"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Workflow className="size-3.5 shrink-0 text-(--mute)" />
                    <span className="truncate">{exec.labels?.workflowName ?? exec.workflowId}</span>
                  </span>
                  <Badge variant="secondary">{t(executionStatus(exec.status).label)}</Badge>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      <details className="rounded-[15px] border border-white/6 bg-(--panel) p-4 text-xs">
        <summary className="cursor-pointer font-[550] text-(--mute) hover:text-(--ink)">
          {t("Session details & diagnostics")}
        </summary>
        <div className="mt-3 space-y-3">
          <div className="rounded-lg border border-(--hairline) bg-(--canvas-soft)/50 p-2.5 text-[11px]">
            <p className="font-medium text-(--ink)">{agentName}</p>
            <p className="mt-0.5 text-[10px] text-(--mute)">{primaryHarness ?? t("Agent")}</p>
            <p className="mt-1 break-all font-mono text-[10px] text-(--faint)">{conversationId}</p>
          </div>
          <RunDiagnostics conversationId={conversationId} agentId={primaryAgentId} />
          <UsagePanel conversationId={conversationId} />
        </div>
      </details>
    </div>
  );

  const contextCount =
    sessionRequirements.length +
    sessionArtifacts.length +
    sessionTerminals.length +
    sessionExecutions.length;

  const effectiveAsideWidth = asideWidth;

  const contextAside = (
    <>
      {asideVisible && (
        <aside
          aria-label={inspectorTarget ? t("Preview") : t("Session context")}
          style={{ width: `${effectiveAsideWidth}px` }}
          className="relative hidden shrink-0 flex-col overflow-hidden border-l border-(--hairline) bg-(--canvas) md:flex"
        >
          {/* Drag-to-resize left handle (mouse + keyboard accessible) */}
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t("Resize side panel")}
            aria-valuemin={320}
            aria-valuemax={720}
            aria-valuenow={effectiveAsideWidth}
            onMouseDown={startResize}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                setAsideWidth((w) => Math.min(720, w + 32));
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                setAsideWidth((w) => Math.max(320, w - 32));
              }
            }}
            className="absolute inset-y-0 left-0 z-20 w-1 cursor-col-resize transition-colors hover:bg-(--primary)/45 focus-visible:bg-(--primary)/60 focus-visible:outline-none"
          />
          {inspectorTarget ? (
            <ChatSidePreviewPane
              target={inspectorTarget}
              onBack={closePreview}
              onClose={() => {
                setInspectorTarget(null);
                setAsideVisible(false);
              }}
              onOpenArtifact={openArtifact}
              onOpenRequirement={openRequirement}
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
              {contextPanels}
            </div>
          )}
        </aside>
      )}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-(--canvas)">
      {/* Antigravity / Codex single-row slim 48px session bar */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-(--hairline) px-3 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            nativeButton={false}
            render={<Link href="/chat" />}
            aria-label={t("All work sessions")}
            title={t("All work sessions")}
            className="shrink-0 text-(--mute) hover:text-(--ink)"
          >
            <ArrowLeft className="size-4" />
          </Button>

          <RoleAvatar kind={mark} name={agentName} size="sm" />

          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <h1
              title={title}
              className="min-w-0 truncate text-sm font-[550] tracking-[-0.2px] text-(--ink)"
            >
              {title}
            </h1>
            {primaryAgentId ? (
              <Link
                href={`/team/${encodeURIComponent(primaryAgentId)}`}
                className="hidden shrink-0 text-xs text-(--mute) transition-colors hover:text-(--primary) sm:inline"
              >
                {agentName}
              </Link>
            ) : null}
            {roomProjectName && roomProjectId && (
              <span className="hidden shrink-0 lg:inline-flex">
                <EntityLink
                  kind="project"
                  id={roomProjectId}
                  label={roomProjectName}
                  href={`/team/projects/${encodeURIComponent(roomProjectId)}`}
                  variant="pill"
                />
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {label && (
            <span className="mr-1 inline-flex items-center gap-1.5 rounded-full border border-(--primary)/25 bg-(--primary)/8 px-2.5 py-0.5 text-[11px] font-medium text-(--primary)">
              <span
                className={`size-1.5 rounded-full ${
                  busy ? "animate-dot-pulse bg-(--primary)" : "bg-(--mute)"
                }`}
              />
              {t(label)}
            </span>
          )}
          {busy && currentRunId && (
            <Button variant="destructive" size="xs" onClick={stopRun} className="mr-1">
              {t("Stop")}
            </Button>
          )}
          {primaryAgentId && (
            <Button
              size="icon-sm"
              variant="ghost"
              nativeButton={false}
              render={<Link href={terminalHref} />}
              aria-label={t("Terminal")}
              title={t("Terminal")}
              className="text-(--mute) hover:text-(--ink)"
            >
              <Terminal className="size-4" />
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            nativeButton={false}
            render={<Link href={artifactsHref} />}
            aria-label={t("Artifacts")}
            title={t("Files this conversation produced (screenshots and other tool output)")}
            className="text-(--mute) hover:text-(--ink)"
          >
            <FolderOpen className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleExport}
            disabled={exporting}
            aria-label={t("Export conversation")}
            title={exporting ? t("Exporting…") : t("Export conversation")}
            className="text-(--mute) hover:text-(--ink)"
          >
            <Download className="size-4" />
          </Button>
          <Button
            variant={asideVisible ? "secondary" : "ghost"}
            size="sm"
            className="hidden h-7 gap-1.5 px-2 text-xs text-(--mute) hover:text-(--ink) md:inline-flex"
            aria-label={asideVisible ? t("Hide context panel") : t("Show context panel")}
            title={asideVisible ? t("Hide context panel") : t("Show context panel")}
            onClick={() => setAsideVisible((v) => !v)}
          >
            {asideVisible ? (
              <PanelRightClose className="size-3.5" />
            ) : (
              <PanelRight className="size-3.5" />
            )}
            {contextCount > 0 && (
              <span className="font-mono text-[10px] tabular-nums">{contextCount}</span>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMobileDrawerOpen(true)}
            className="h-7 gap-1 px-2 text-xs text-(--mute) md:hidden"
          >
            <PanelRight className="size-3.5" />
            {contextCount > 0 && (
              <span className="font-mono text-[10px] tabular-nums">{contextCount}</span>
            )}
          </Button>
        </div>
      </div>

      <ChatInspectorContext.Provider value={inspectorController}>
        <ConversationPanel
          conversationId={conversationId}
          conversation={conversation}
          anchorSeq={anchorSeq}
          skills={skills}
          emptyTitle={
            primaryAgent ? (
              <div className="flex flex-col items-center gap-2.5">
                <RoleAvatar kind={mark} name={agentName} size="lg" />
                <p className="text-base font-[550] tracking-[-0.2px] text-(--ink-strong)">
                  {agentName}
                </p>
              </div>
            ) : null
          }
          emptyDescription={member?.description || undefined}
          aside={contextAside}
        />
      </ChatInspectorContext.Provider>

      {/* Mobile Session Context / Preview drawer */}
      {(mobileDrawerOpen || inspectorTarget !== null) && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={() => {
              setMobileDrawerOpen(false);
              setInspectorTarget(null);
            }}
          />
          <aside
            id="session-context-drawer"
            className="fixed inset-y-0 right-0 z-50 flex w-[90vw] max-w-md flex-col overflow-hidden border-l border-(--hairline) bg-(--canvas) shadow-lg md:hidden"
            role="dialog"
            aria-label={inspectorTarget ? t("Preview") : t("Session context")}
          >
            {inspectorTarget ? (
              <ChatSidePreviewPane
                target={inspectorTarget}
                onBack={closePreview}
                onClose={() => {
                  setInspectorTarget(null);
                  setMobileDrawerOpen(false);
                }}
                onOpenArtifact={openArtifact}
                onOpenRequirement={openRequirement}
              />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-[550] text-(--ink-strong)">
                    {t("Session context")}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("Close")}
                    onClick={() => setMobileDrawerOpen(false)}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
                {contextPanels}
              </div>
            )}
          </aside>
        </>
      )}
    </div>
  );
}
