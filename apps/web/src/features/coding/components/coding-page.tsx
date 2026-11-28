"use client";

import {
  AlertTriangleIcon,
  BellIcon,
  BellOffIcon,
  BellRingIcon,
  Columns2Icon,
  FileDiffIcon,
  GitBranchIcon,
  MessageSquareIcon,
  PlusIcon,
  TerminalIcon,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page";
import { ActiveFilterBar, type ActiveFilterChip } from "@/components/ui/active-filter-bar";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { entityLabelText } from "@/components/ui/entity-link";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgentList } from "@/features/agents/hooks";
import { useAllConversations } from "@/features/conversations/hooks";
import { useProjectList } from "@/features/projects/hooks";
import { useRequirement } from "@/features/requirements/hooks";
import { isRequirementDetail } from "@/features/requirements/queries";
import type { CodingHarness, CodingTerminalRow, CodingWorkspaceRow, ProjectRow } from "@/lib/api";
import { conversationDisplayName } from "@/lib/conversation-title";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  useCloseTerminal,
  useCodingTerminals,
  useCodingWorkspaces,
  useCodingWorktreeDiff,
  useSpawnTerminal,
} from "../hooks";
import {
  buildCodingUrl,
  CODING_HARNESS_OPTIONS,
  type LocateMiss,
  type LocateRegistry,
  pickResumeTerminal,
  resolveLocate,
  terminalsForSelection,
} from "../locate";
import {
  type CodingNotifyPref,
  readNotifyPref,
  subscribeNotifyPref,
  writeNotifyPref,
} from "../notifications";
import {
  CodingRail,
  type CodingSelection,
  selectionOfTerminal,
  terminalDot,
  workspaceDot,
} from "./coding-rail";
import { NewTerminalDialog, type TerminalPrefill } from "./new-terminal-dialog";
import { SplitView } from "./split-view";
import { TerminalPane } from "./terminal-pane";

/** What the address asked for when the page opened (ADR 0073 `?agent=`, ADR 0076 `?project=`,
 *  ADR 0082 `?requirement=`/`?conversation=`). Read once so URL updates never erase initial intent. */
interface Entry {
  agentId: string | null;
  projectId: string | null;
  conversationId: string | null;
  requirementId: string | null;
  /** `?locate=1`: only focus a view that exists; never start one. */
  locate: boolean;
}

interface Landing {
  entry: Entry | null;
  /** `?t=<terminalId>`: land back on the pane you left. */
  tabHint: string | null;
}

function readLanding(): Landing {
  if (typeof window === "undefined") return { entry: null, tabHint: null };
  const params = new URLSearchParams(window.location.search);
  const tabHint = params.get("t");
  const agentId = params.get("agent");
  const project = params.get("project");
  const conversationId = params.get("conversation");
  const requirementId = params.get("requirement");
  if (agentId === null && project === null && conversationId === null && requirementId === null) {
    return { entry: null, tabHint };
  }
  const entry: Entry = {
    agentId,
    projectId: project,
    conversationId,
    requirementId,
    locate: params.get("locate") === "1" || agentId === null,
  };
  return { entry, tabHint };
}

function readSplit(): string {
  if (typeof window === "undefined") return "0";
  return window.localStorage.getItem("coding-split") === "1" ? "1" : "0";
}

function readSavedResume(): { terminalId: string | null; workspaceId: string | null } {
  if (typeof window === "undefined") return { terminalId: null, workspaceId: null };
  try {
    return {
      terminalId: window.localStorage.getItem("coding-last-terminal"),
      workspaceId: window.localStorage.getItem("coding-last-workspace"),
    };
  } catch {
    return { terminalId: null, workspaceId: null };
  }
}

type BrowserNotifyPerm = "default" | "granted" | "denied" | "unsupported";

function readBrowserNotifyPerm(): BrowserNotifyPerm {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission;
}

function scopeName(projectId: string | null, registry: LocateRegistry): string {
  if (projectId === null) return t("its own workspace");
  const project = registry.projects.find((row) => row.projectId === projectId);
  return project === undefined ? projectId : project.name;
}

/** Why a locate found nothing, in the person's words. */
function missText(miss: LocateMiss, entry: Entry, registry: LocateRegistry): string {
  if (miss.reason === "unknown-agent") {
    return t("No member with the id {id} is registered.", { id: entry.agentId ?? "" });
  }
  if (miss.reason === "unknown-project") {
    return t("No project with the id {id} is registered.", { id: entry.projectId ?? "" });
  }
  const agent = entry.agentId ? registry.agents.find((row) => row.id === entry.agentId) : undefined;
  const name = agent === undefined ? (entry.agentId ?? t("This context")) : agent.name;
  if (miss.elsewhere.length === 0) return t("{name} has no terminal yet.", { name });
  const places = [...new Set(miss.elsewhere.map((row) => scopeName(row.projectId, registry)))];
  return t("{name} has no terminal in {scope}. It has {n} elsewhere: {places}.", {
    name,
    scope: scopeName(entry.projectId, registry),
    n: miss.elsewhere.length,
    places: places.join(", "),
  });
}

function isHarnessOption(value: string | undefined): value is CodingHarness {
  return value !== undefined && (CODING_HARNESS_OPTIONS as readonly string[]).includes(value);
}

function WorktreeDiffDialog({
  workspace,
  open,
  onClose,
}: {
  workspace: CodingWorkspaceRow | null;
  open: boolean;
  onClose: () => void;
}) {
  const diffQuery = useCodingWorktreeDiff(
    workspace?.projectId ?? null,
    workspace?.workspaceId ?? null,
    open && workspace !== null,
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[82vh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t("Workspace diff")} · {workspace?.requirementTitle ?? workspace?.branch ?? ""}
          </DialogTitle>
          <DialogDescription>
            {workspace ? `${workspace.projectName} · ${workspace.branch}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto rounded-lg border border-(--hairline) bg-[#0d1117] p-3 font-mono text-xs text-(--body)">
          {diffQuery.isLoading ? (
            <div className="text-(--mute)">{t("Loading git diff…")}</div>
          ) : diffQuery.isError ? (
            <div className="text-(--err)">{String(diffQuery.error)}</div>
          ) : !diffQuery.data?.diff || diffQuery.data.diff.trim() === "" ? (
            <div className="text-(--mute)">
              {t("Working tree is clean — no diff against base.")}
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-all">{diffQuery.data.diff}</pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CodingPage() {
  const terminalsQuery = useCodingTerminals();
  const workspacesQuery = useCodingWorkspaces();
  const agentsQuery = useAgentList();
  const projectsQuery = useProjectList();
  const conversationsQuery = useAllConversations();
  const [landing] = useState(readLanding);
  const [contextFilter, setContextFilter] = useState<{
    conversationId: string | null;
    requirementId: string | null;
    projectId: string | null;
  }>(() => ({
    conversationId: landing.entry?.conversationId ?? null,
    requirementId: landing.entry?.requirementId ?? null,
    projectId: landing.entry?.projectId ?? null,
  }));
  const reqDetail = useRequirement(contextFilter.requirementId ?? "");
  const allTerminals = terminalsQuery.data === undefined ? [] : terminalsQuery.data.terminals;
  const allWorkspaces = workspacesQuery.data === undefined ? [] : workspacesQuery.data.workspaces;

  const terminals = allTerminals.filter((item) => {
    if (contextFilter.conversationId && item.conversationId !== contextFilter.conversationId) {
      return false;
    }
    if (contextFilter.requirementId && item.requirementId !== contextFilter.requirementId) {
      return false;
    }
    return true;
  });

  const workspaces = allWorkspaces.filter((ws) => {
    if (contextFilter.requirementId && ws.requirementId !== contextFilter.requirementId) {
      return false;
    }
    if (contextFilter.projectId && ws.projectId !== contextFilter.projectId) {
      return false;
    }
    return true;
  });

  const agents = agentsQuery.data ?? [];
  const projects: ProjectRow[] =
    projectsQuery.data === undefined ? [] : projectsQuery.data.projects;
  const registry: LocateRegistry = { agents, projects };
  const entry = landing.entry;
  const [selected, setSelected] = useState<CodingSelection | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [splitPref, setSplitPref] = useState(readSplit);
  const [tabHint, setTabHint] = useState<string | null>(landing.tabHint);
  const [savedResume] = useState(readSavedResume);
  const [notifyPref, setNotifyPref] = useState<CodingNotifyPref>(readNotifyPref);
  const [notifyPerm, setNotifyPerm] = useState<BrowserNotifyPerm>(readBrowserNotifyPerm);
  const [diffOpen, setDiffOpen] = useState(false);
  const hasAutoResumedRef = useRef(false);
  const spawn = useSpawnTerminal();
  const closeTerminal = useCloseTerminal();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [miss, setMiss] = useState<LocateMiss | null>(null);
  const [newOpen, setNewOpen] = useState<"closed" | "open">("closed");
  const [prefill, setPrefill] = useState<TerminalPrefill | null>(null);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const split = splitPref === "1";

  useEffect(() => subscribeNotifyPref(setNotifyPref), []);

  useEffect(() => {
    try {
      window.localStorage.setItem("coding-split", splitPref);
    } catch {
      /* private mode — preference just doesn't persist */
    }
  }, [splitPref]);

  const listReady = terminalsQuery.isSuccess;
  const registryReady = agentsQuery.isSuccess && projectsQuery.isSuccess;
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;
  const workspacesRef = useRef(allWorkspaces);
  workspacesRef.current = allWorkspaces;
  const registryRef = useRef(registry);
  registryRef.current = registry;
  const spawnRef = useRef(spawn);
  spawnRef.current = spawn;

  useEffect(() => {
    if (entry === null) return;
    if (entry.locate) {
      if (!listReady || !registryReady) return;
      const directMatch =
        entry.conversationId || entry.requirementId
          ? terminalsRef.current.find(
              (row) =>
                (entry.conversationId ? row.conversationId === entry.conversationId : true) &&
                (entry.requirementId ? row.requirementId === entry.requirementId : true),
            )
          : undefined;
      if (directMatch !== undefined) {
        setSelected({
          agentId: directMatch.agentId,
          ...(directMatch.projectId !== null ? { projectId: directMatch.projectId } : {}),
          ...(directMatch.workspaceId
            ? { workspaceId: directMatch.workspaceId, worktreePath: directMatch.cwd }
            : {}),
          ...(directMatch.requirementId ? { requirementId: directMatch.requirementId } : {}),
          ...(directMatch.conversationId ? { conversationId: directMatch.conversationId } : {}),
        });
        setActiveId(directMatch.terminalId);
        setMiss(null);
        return;
      }
      if (entry.agentId === null) {
        setMiss({ reason: "no-terminal", elsewhere: [] });
        return;
      }
      const target = { agentId: entry.agentId, projectId: entry.projectId ?? undefined };
      const result = resolveLocate(terminalsRef.current, target, registryRef.current);
      if (result.ok) {
        setSelected(result.selection);
        setActiveId(result.terminal.terminalId);
        setMiss(null);
      } else {
        setMiss(result.miss);
      }
      return;
    }
    if (!listReady || entry.agentId === null) return;
    const matchedWs = entry.requirementId
      ? workspacesRef.current.find((ws) => ws.requirementId === entry.requirementId)
      : undefined;
    const selection: CodingSelection = {
      agentId: entry.agentId,
      ...(entry.projectId !== null ? { projectId: entry.projectId } : {}),
      ...(matchedWs ? { workspaceId: matchedWs.workspaceId, worktreePath: matchedWs.path } : {}),
      ...(entry.requirementId ? { requirementId: entry.requirementId } : {}),
      ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
    };
    const body: {
      agentId: string;
      title: string;
      projectId?: string;
      workspaceId?: string;
      conversationId?: string;
      requirementId?: string;
    } = {
      agentId: entry.agentId,
      title: "bash",
    };
    if (entry.projectId !== null) body.projectId = entry.projectId;
    if (matchedWs) body.workspaceId = matchedWs.workspaceId;
    if (entry.conversationId !== null) body.conversationId = entry.conversationId;
    if (entry.requirementId !== null) body.requirementId = entry.requirementId;
    setSelected(selection);
    const exists = terminalsRef.current.some(
      (row) => row.agentId === entry.agentId && (row.projectId ?? null) === entry.projectId,
    );
    if (!exists) spawnRef.current.mutate(body);
  }, [entry, listReady, registryReady]);

  const selTerminals = terminalsForSelection(terminals, selected);
  let active = selTerminals.find((x) => x.terminalId === activeId) ?? null;
  if (active === null) active = selTerminals.find((x) => x.terminalId === tabHint) ?? null;
  if (active === null) active = selTerminals.at(0) ?? null;

  // ADR 0083 D6: automatically resume the previous coding agent terminal when opening `/coding`
  // (URL `?t=` hint -> last focused terminal -> last workspace -> highest-attention running pane).
  useEffect(() => {
    if (hasAutoResumedRef.current) return;
    if (entry !== null || selected !== null || miss !== null) return;
    if (!listReady) return;
    hasAutoResumedRef.current = true;
    const resumed = pickResumeTerminal(terminalsRef.current, {
      tabHint,
      savedTerminalId: savedResume.terminalId,
      savedWorkspaceId: savedResume.workspaceId,
    });
    if (resumed === null) return;
    const matchedWs = workspacesRef.current.find(
      (ws) =>
        (resumed.workspaceId !== null && ws.workspaceId === resumed.workspaceId) ||
        ws.path === resumed.cwd,
    );
    const sel: CodingSelection = selectionOfTerminal(resumed);
    if (matchedWs) {
      sel.workspaceId = matchedWs.workspaceId;
      sel.worktreePath = matchedWs.path;
      if (matchedWs.requirementId) sel.requirementId = matchedWs.requirementId;
      if (matchedWs.conversationId) sel.conversationId = matchedWs.conversationId;
    }
    setSelected(sel);
    setActiveId(resumed.terminalId);
  }, [entry, listReady, miss, savedResume, selected, tabHint]);

  useEffect(() => {
    if (active === null) return;
    setActiveId(active.terminalId);
    try {
      window.localStorage.setItem("coding-last-terminal", active.terminalId);
      if (active.workspaceId) {
        window.localStorage.setItem("coding-last-workspace", active.workspaceId);
      } else {
        window.localStorage.removeItem("coding-last-workspace");
      }
    } catch {
      /* private mode */
    }
  }, [active]);

  // Resolve the active workspace context (for dual-view bar, git diff, and anti-collision banner).
  const activeWorkspace: CodingWorkspaceRow | null =
    allWorkspaces.find(
      (ws) =>
        (selected?.workspaceId !== undefined && ws.workspaceId === selected.workspaceId) ||
        (active?.workspaceId !== null &&
          active?.workspaceId !== undefined &&
          ws.workspaceId === active.workspaceId) ||
        (active !== null && ws.path === active.cwd) ||
        (selected?.worktreePath !== undefined && ws.path === selected.worktreePath),
    ) ??
    (contextFilter.requirementId
      ? (allWorkspaces.find((ws) => ws.requirementId === contextFilter.requirementId) ?? null)
      : null);

  const linkedRequirementId =
    active?.requirementId ??
    activeWorkspace?.requirementId ??
    selected?.requirementId ??
    contextFilter.requirementId;
  const linkedConversationId =
    active?.conversationId ??
    activeWorkspace?.conversationId ??
    selected?.conversationId ??
    contextFilter.conversationId;
  const linkedProjectId =
    active?.projectId ??
    activeWorkspace?.projectId ??
    selected?.projectId ??
    contextFilter.projectId;

  // Keep the URL in sync WITHOUT erasing dual-view context params (ADR 0083 D5).
  useEffect(() => {
    const url = buildCodingUrl({
      terminalId: active?.terminalId ?? null,
      requirementId: contextFilter.requirementId ?? activeWorkspace?.requirementId ?? null,
      conversationId: contextFilter.conversationId ?? activeWorkspace?.conversationId ?? null,
      projectId: contextFilter.projectId ?? null,
    });
    window.history.replaceState(null, "", url);
  }, [
    active?.terminalId,
    contextFilter.requirementId,
    contextFilter.conversationId,
    contextFilter.projectId,
    activeWorkspace?.requirementId,
    activeWorkspace?.conversationId,
  ]);

  // A terminal that was just created is focused as soon as the list knows it.
  useEffect(() => {
    if (pendingFocus === null) return;
    if (!terminals.some((x) => x.terminalId === pendingFocus)) return;
    setActiveId(pendingFocus);
    setPendingFocus(null);
  }, [pendingFocus, terminals]);

  async function requestClose(term: CodingTerminalRow) {
    const dead = term.status === "exited";
    if (
      dead ||
      (await confirm({
        title: t("Close terminal?"),
        description: t("This kills the running process. Its session history stays on disk."),
      }))
    ) {
      closeTerminal.mutate(term.terminalId);
    }
  }
  function closeById(id: string): void {
    const term = selTerminals.find((x) => x.terminalId === id);
    if (term !== undefined) void requestClose(term);
  }
  function selectScope(sel: CodingSelection): void {
    setSelected(sel);
    setActiveId(null);
    setTabHint(null);
    setMiss(null);
  }
  function focusTerminal(sel: CodingSelection, terminalId: string): void {
    setSelected(sel);
    setActiveId(terminalId);
    setTabHint(null);
    setMiss(null);
  }
  function openNew(withPrefill: TerminalPrefill | null): void {
    setPrefill(withPrefill);
    setNewOpen("open");
  }

  const defaultHarnessFor = (term: CodingTerminalRow): CodingHarness => {
    const agent = agents.find((a) => a.id === term.agentId);
    if (isHarnessOption(agent?.harness)) return agent.harness;
    if (activeWorkspace && isHarnessOption(activeWorkspace.defaultHarness)) {
      return activeWorkspace.defaultHarness;
    }
    return "oma";
  };

  // Merge active ACP runs for the selected workspace / active terminal (anti-collision banner).
  const activeRunsMap = new Map<
    string,
    {
      runId: string;
      agentName: string;
      status: string;
      conversationId: string;
      pendingActionCount: number;
    }
  >();
  for (const run of activeWorkspace?.activeRuns ?? []) {
    activeRunsMap.set(run.runId, run);
  }
  for (const run of active?.activeRuns ?? []) {
    activeRunsMap.set(run.runId, run);
  }
  const activeRuns = [...activeRunsMap.values()];
  const waitingRun = activeRuns.find((r) => r.status === "waiting" || r.pendingActionCount > 0);
  const primaryActiveRun = waitingRun ?? activeRuns[0] ?? null;

  const conversationHref = linkedConversationId
    ? `/chat/${encodeURIComponent(linkedConversationId)}`
    : linkedRequirementId
      ? `/requirements/${encodeURIComponent(linkedRequirementId)}`
      : null;

  async function toggleNotifications(): Promise<void> {
    if (notifyPref === "muted") {
      writeNotifyPref("on");
      if (notifyPerm === "default" && typeof window !== "undefined" && "Notification" in window) {
        const next = await window.Notification.requestPermission();
        setNotifyPerm(next);
        if (next === "granted") {
          toast.success(t("Desktop & in-app notifications enabled"));
          return;
        }
      }
      toast.success(t("Notifications enabled"));
      return;
    }
    if (notifyPerm === "default" && typeof window !== "undefined" && "Notification" in window) {
      const next = await window.Notification.requestPermission();
      setNotifyPerm(next);
      if (next === "granted") {
        toast.success(t("Desktop & in-app notifications enabled"));
      } else {
        toast.info(t("Browser desktop notifications blocked; in-app toasts stay active."));
      }
      return;
    }
    writeNotifyPref("muted");
    toast.info(t("Coding notifications muted"));
  }

  const notifyLabel =
    notifyPref === "muted"
      ? t("Muted")
      : notifyPerm === "granted"
        ? t("Alerts on")
        : t("Enable desktop alerts");

  const notifyTitle =
    notifyPref === "muted"
      ? t("Coding agent completion & approval notifications are muted. Click to enable.")
      : notifyPerm === "granted"
        ? t(
            "Toast & desktop notifications active when coding agents finish or need input. Click to mute.",
          )
        : notifyPerm === "default"
          ? t("In-app toasts active. Click to also enable OS desktop notifications.")
          : t("In-app toast notifications active. Click to mute.");

  const running = terminals.filter((row) => row.status === "running").length;
  const blockedCount = workspaces.filter((ws) => ws.state === "blocked").length;
  const fewPanes = selTerminals.length < 2;
  const splitHint = fewPanes
    ? t("Needs at least two terminals in this scope. It never creates one.")
    : undefined;

  const tabClass = (term: CodingTerminalRow): string => {
    const isActive = active !== null && active.terminalId === term.terminalId;
    return cn(
      "h-auto gap-1.5 rounded-md px-2 py-1 text-xs font-normal",
      isActive ? "bg-(--panel2) text-(--ink)" : "text-(--mute) hover:bg-(--panel2)",
    );
  };

  let panes: ReactNode = (
    <div className="flex h-full items-center justify-center text-sm text-(--mute)">
      {t("Opening terminal…")}
    </div>
  );
  if (active !== null) {
    panes = (
      <TerminalPane
        key={active.terminalId}
        terminal={active}
        defaultHarness={defaultHarnessFor(active)}
        onClosed={closeById}
      />
    );
  }
  if (split) {
    panes = (
      <SplitView
        terminals={selTerminals}
        defaultHarnessFor={defaultHarnessFor}
        onClosed={closeById}
      />
    );
  }

  let main: ReactNode = (
    <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-(--hairline) p-6 text-center text-sm text-(--mute)">
      <div>{t("Pick a workspace on the left to open its terminal.")}</div>
      <div className="text-xs text-(--faint)">
        {t("Terminals keep running when you leave this page — detach, not close.")}
      </div>
    </div>
  );
  if (miss !== null && entry !== null) {
    main = (
      <div
        role="status"
        className="flex h-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-(--hairline) p-6 text-center"
      >
        <p className="text-sm text-(--ink)">{t("No terminal to locate")}</p>
        <p className="max-w-md text-xs leading-[1.8] text-(--mute)">
          {missText(miss, entry, registry)}
        </p>
        <p className="max-w-md text-[10px]/[1.8] text-(--faint)">
          {t("This link only locates a view that already exists. Nothing was created.")}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            onClick={() =>
              openNew({
                agentId: entry.agentId ?? activeWorkspace?.defaultAgentId,
                projectId: entry.projectId === null ? activeWorkspace?.projectId : entry.projectId,
                workspaceId: activeWorkspace?.workspaceId,
                conversationId: entry.conversationId ?? undefined,
                requirementId: entry.requirementId ?? undefined,
              })
            }
          >
            {t("Create terminal")}
          </Button>
          <Button variant="outline" onClick={() => setMiss(null)}>
            {t("Dismiss")}
          </Button>
        </div>
      </div>
    );
  }
  if (selected !== null) {
    main = (
      <>
        {primaryActiveRun !== null ? (
          <div
            role="status"
            className={cn(
              "mb-2 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs",
              waitingRun
                ? "border-(--warn)/40 bg-(--warn)/10 text-(--warn)"
                : "border-(--primary)/35 bg-(--primary)/10 text-(--ink)",
            )}
          >
            <AlertTriangleIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              {waitingRun
                ? t("{name} is waiting for approval in this workspace.", {
                    name: primaryActiveRun.agentName,
                  })
                : t(
                    "ACP worker {name} is actively running in this workspace. Interactive edits here may collide with the worker.",
                    { name: primaryActiveRun.agentName },
                  )}
            </span>
            <Button
              size="sm"
              variant={waitingRun ? "default" : "outline"}
              className="h-7 text-xs"
              render={
                <Link href={`/chat/${encodeURIComponent(primaryActiveRun.conversationId)}`} />
              }
            >
              <MessageSquareIcon className="size-3" />
              {waitingRun ? t("Review in Conversation") : t("Open Conversation")}
            </Button>
          </div>
        ) : null}
        <div className="flex items-center gap-1 rounded-t-xl border border-(--hairline) bg-(--panel) px-2 py-1">
          {selTerminals.map((term) => {
            const dot = terminalDot(term);
            return (
              <div key={term.terminalId} className="group flex items-center">
                <Button
                  variant="ghost"
                  onClick={() => setActiveId(term.terminalId)}
                  className={tabClass(term)}
                >
                  <span className={dot.cls} title={t(dot.label)}>
                    {dot.mark}
                  </span>
                  {term.title}
                </Button>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-5 opacity-0 transition-opacity group-hover:opacity-100"
                        aria-label={t("Close terminal (kills the process)")}
                        onClick={() => void requestClose(term)}
                      />
                    }
                  />
                  <TooltipContent>{t("Close (kills process)")}</TooltipContent>
                </Tooltip>
              </div>
            );
          })}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={t("New terminal in this worktree")}
                  onClick={() =>
                    spawn.mutate({
                      ...(selected.projectId ? { projectId: selected.projectId } : {}),
                      agentId: selected.agentId,
                      ...(selected.workspaceId ? { workspaceId: selected.workspaceId } : {}),
                      ...(linkedRequirementId ? { requirementId: linkedRequirementId } : {}),
                      ...(linkedConversationId ? { conversationId: linkedConversationId } : {}),
                      title: "bash",
                    })
                  }
                >
                  <PlusIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipContent>{t("New terminal in this worktree")}</TooltipContent>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden rounded-b-xl border border-(--hairline)">
          {panes}
        </div>
      </>
    );
  }

  // Viewport-fixed layout: AppShell's <main> is a flex column with a real
  // height — the document-flow Page/PageBody pair would let the terminal
  // grow the whole page instead of scrolling inside xterm.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {confirmDialog}
      <WorktreeDiffDialog
        workspace={activeWorkspace}
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
      />
      <PageHeader
        kicker={t("Coding workbench · dual view")}
        title={t("Coding")}
        description={t(
          "Workspaces shared between Conversation and Coding. Launch oma, claude, pi, or omp in detachable terminals with live semantic state.",
        )}
        actions={
          <Button
            onClick={() =>
              openNew(
                linkedConversationId || linkedRequirementId || linkedProjectId || activeWorkspace
                  ? {
                      agentId: selected?.agentId ?? activeWorkspace?.defaultAgentId,
                      projectId: linkedProjectId ?? undefined,
                      workspaceId: activeWorkspace?.workspaceId,
                      conversationId: linkedConversationId ?? undefined,
                      requirementId: linkedRequirementId ?? undefined,
                    }
                  : null,
              )
            }
          >
            <PlusIcon />
            {t("New terminal")}
          </Button>
        }
      />
      {(contextFilter.conversationId || contextFilter.requirementId) && (
        <div className="mb-3 px-4 sm:px-6 lg:px-8">
          <ActiveFilterBar
            chips={[
              ...(contextFilter.requirementId
                ? [
                    {
                      key: "requirement",
                      category: t("Requirement"),
                      value: entityLabelText(
                        "requirement",
                        contextFilter.requirementId,
                        isRequirementDetail(reqDetail.data)
                          ? reqDetail.data.requirement.title
                          : (allWorkspaces.find(
                              (ws) => ws.requirementId === contextFilter.requirementId,
                            )?.requirementTitle ??
                              allTerminals.find(
                                (x) => x.requirementId === contextFilter.requirementId,
                              )?.labels?.requirementTitle),
                      ),
                      href: `/requirements/${encodeURIComponent(contextFilter.requirementId)}`,
                      onRemove: () => {
                        setContextFilter((prev) => ({ ...prev, requirementId: null }));
                        setMiss(null);
                      },
                    } satisfies ActiveFilterChip,
                  ]
                : []),
              ...(contextFilter.conversationId
                ? [
                    {
                      key: "conversation",
                      category: t("Conversation"),
                      value: entityLabelText(
                        "conversation",
                        contextFilter.conversationId,
                        (() => {
                          const found = conversationsQuery.data?.find(
                            (c) => c.conversationId === contextFilter.conversationId,
                          );
                          return found
                            ? conversationDisplayName(found)
                            : allTerminals.find(
                                (x) => x.conversationId === contextFilter.conversationId,
                              )?.labels?.conversationTitle;
                        })(),
                      ),
                      href: `/chat/${encodeURIComponent(contextFilter.conversationId)}`,
                      onRemove: () => {
                        setContextFilter((prev) => ({ ...prev, conversationId: null }));
                        setMiss(null);
                      },
                    } satisfies ActiveFilterChip,
                  ]
                : []),
            ]}
            onClearAll={() => {
              setContextFilter({ conversationId: null, requirementId: null, projectId: null });
              setMiss(null);
            }}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2.5 px-4 sm:px-6 lg:px-8">
        <span className="text-xs leading-[1.8] text-(--mute)">
          {t("{workspaces} workspaces · {open} panes · {running} running", {
            workspaces: workspaces.length,
            open: terminals.length,
            running,
          })}
          {blockedCount > 0 ? (
            <span className="ml-2 font-medium text-(--warn)">
              · {t("{n} blocked", { n: blockedCount })}
            </span>
          ) : null}
        </span>

        {activeWorkspace !== null ? (
          <div className="flex items-center gap-1.5 rounded-lg border border-(--hairline) bg-(--panel) px-2.5 py-1 text-xs">
            <span className={workspaceDot(activeWorkspace.state).cls}>
              {workspaceDot(activeWorkspace.state).mark}
            </span>
            <span className="max-w-48 truncate font-medium text-(--ink)">
              {activeWorkspace.requirementTitle ?? activeWorkspace.branch}
            </span>
            <span className="hidden items-center gap-1 font-mono text-[10px] text-(--mute) sm:inline-flex">
              <GitBranchIcon className="size-3" />
              {activeWorkspace.branch}
              {activeWorkspace.ahead > 0 ? ` ↑${activeWorkspace.ahead}` : ""}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-1 h-6 px-2 text-[11px]"
              onClick={() => setDiffOpen(true)}
            >
              <FileDiffIcon className="size-3" />
              {t("Diff")}
            </Button>
          </div>
        ) : null}

        <span className="flex-1" />

        {conversationHref !== null ? (
          <div
            className="inline-flex items-center rounded-lg border border-(--hairline) bg-(--panel) p-0.5 text-xs"
            role="group"
            aria-label={t("Switch view")}
          >
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 rounded-md px-2.5 text-xs text-(--mute) hover:text-(--ink)"
              render={<Link href={conversationHref} />}
            >
              <MessageSquareIcon className="size-3.5" />
              {t("Conversation view")}
            </Button>
            <span className="inline-flex h-7 items-center gap-1.5 rounded-md bg-(--panel2) px-2.5 text-xs font-medium text-(--ink)">
              <TerminalIcon className="size-3.5 text-(--primary)" />
              {t("Coding view")}
            </span>
          </div>
        ) : null}

        <Button
          size="sm"
          variant="outline"
          aria-pressed={notifyPref === "on"}
          title={notifyTitle}
          onClick={() => void toggleNotifications()}
        >
          {notifyPref === "muted" ? (
            <BellOffIcon className="size-3.5 text-(--mute)" />
          ) : notifyPerm === "granted" ? (
            <BellRingIcon className="size-3.5 text-(--primary)" />
          ) : (
            <BellIcon className="size-3.5" />
          )}
          {notifyLabel}
        </Button>

        <Button
          size="sm"
          variant="outline"
          aria-pressed={split}
          disabled={fewPanes}
          title={splitHint}
          onClick={() => setSplitPref(split ? "0" : "1")}
        >
          <Columns2Icon className="size-3.5" />
          {split ? t("Single view") : t("Split · two columns")}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 gap-4 px-4 pt-[18px] pb-4 sm:px-6 lg:px-8">
        <CodingRail
          workspaces={workspaces}
          terminals={terminals}
          selected={selected}
          activeTerminalId={active?.terminalId ?? null}
          onSelect={selectScope}
          onFocus={focusTerminal}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">{main}</main>
      </div>
      <NewTerminalDialog
        open={newOpen === "open"}
        onClose={() => setNewOpen("closed")}
        agents={agents}
        projects={projects}
        prefill={prefill}
        onCreated={setPendingFocus}
      />
    </div>
  );
}
