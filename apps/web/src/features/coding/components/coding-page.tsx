"use client";

import { Columns2Icon, PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/page";
import { ActiveFilterBar, type ActiveFilterChip } from "@/components/ui/active-filter-bar";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { entityLabelText } from "@/components/ui/entity-link";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgentList } from "@/features/agents/hooks";
import { useAllConversations } from "@/features/conversations/hooks";
import { useProjectList } from "@/features/projects/hooks";
import { useRequirement } from "@/features/requirements/hooks";
import { isRequirementDetail } from "@/features/requirements/queries";
import type { CodingTerminalRow, ProjectRow } from "@/lib/api";
import { conversationDisplayName } from "@/lib/conversation-title";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useCloseTerminal, useCodingTerminals, useSpawnTerminal } from "../hooks";
import { isTaskWorktreeCwd, type LocateMiss, type LocateRegistry, resolveLocate } from "../locate";
import { CodingRail, type CodingSelection, terminalDot } from "./coding-rail";
import { NewTerminalDialog, type TerminalPrefill } from "./new-terminal-dialog";
import { SplitView } from "./split-view";
import { TerminalPane } from "./terminal-pane";

/** What the address asked for when the page opened (ADR 0073 `?agent=`, ADR 0076 `?project=`).
 *  Read once: the page keeps the address in step with the focused pane, which would otherwise
 *  erase the request before the lists have loaded. */
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

export function CodingPage() {
  const terminalsQuery = useCodingTerminals();
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
  const terminals = allTerminals.filter((item) => {
    if (contextFilter.conversationId && item.conversationId !== contextFilter.conversationId) {
      return false;
    }
    if (contextFilter.requirementId && item.requirementId !== contextFilter.requirementId) {
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
  const spawn = useSpawnTerminal();
  const closeTerminal = useCloseTerminal();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [miss, setMiss] = useState<LocateMiss | null>(null);
  const [newOpen, setNewOpen] = useState<"closed" | "open">("closed");
  const [prefill, setPrefill] = useState<TerminalPrefill | null>(null);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const split = splitPref === "1";
  useEffect(() => {
    try {
      window.localStorage.setItem("coding-split", splitPref);
    } catch {
      /* private mode — preference just doesn't persist */
    }
  }, [splitPref]);

  // The lists are the source of truth for "does a pane exist". An empty list while it is still
  // loading is not "no terminal", so a link waits for it.
  const listReady = terminalsQuery.isSuccess;
  const registryReady = agentsQuery.isSuccess && projectsQuery.isSuccess;
  // Latest values through refs: the effect fires on a readiness or PARAM change only. Depending
  // on `terminals` would re-run it on every poll, and depending on `spawn` (a fresh mutation
  // object each render) would loop.
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;
  const registryRef = useRef(registry);
  registryRef.current = registry;
  const spawnRef = useRef(spawn);
  spawnRef.current = spawn;
  useEffect(() => {
    if (entry === null) return;
    if (entry.locate) {
      if (!listReady || !registryReady) return;
      // Prefer exact match on conversationId or requirementId when present (ADR 0082 D3).
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
    const selection: CodingSelection = { agentId: entry.agentId };
    const body: {
      agentId: string;
      title: string;
      projectId?: string;
      conversationId?: string;
      requirementId?: string;
    } = {
      agentId: entry.agentId,
      title: "bash",
    };
    if (entry.projectId !== null) {
      selection.projectId = entry.projectId;
      body.projectId = entry.projectId;
    }
    if (entry.conversationId !== null) body.conversationId = entry.conversationId;
    if (entry.requirementId !== null) body.requirementId = entry.requirementId;
    setSelected(selection);
    const exists = terminalsRef.current.some(
      (row) => row.agentId === entry.agentId && (row.projectId ?? null) === entry.projectId,
    );
    // The legacy link is meant to do something on click: it opens one when this member has no
    // terminal there yet. `?locate=1` never does.
    if (!exists) spawnRef.current.mutate(body);
  }, [entry, listReady, registryReady]);

  const selTerminals = selected
    ? terminals.filter((x) => {
        if (x.agentId !== selected.agentId) return false;
        if (selected.projectId === undefined) {
          // ADR 0073: a workspace pane — no project, no worktree split.
          return x.projectId === null;
        }
        if (x.projectId !== selected.projectId) return false;
        // A task-worktree selection groups ONLY that path's terminals;
        // a main selection groups the terminals whose cwd isn't a task
        // path (they never set worktreePath at spawn).
        return selected.worktreePath === undefined
          ? !isTaskWorktreeCwd(x.cwd)
          : x.cwd === selected.worktreePath;
      })
    : [];
  let active = selTerminals.find((x) => x.terminalId === activeId) ?? null;
  if (active === null) active = selTerminals.find((x) => x.terminalId === tabHint) ?? null;
  if (active === null) active = selTerminals.at(0) ?? null;
  useEffect(() => {
    if (active !== null) setActiveId(active.terminalId);
  }, [active]);

  // Keep the URL in sync so a refresh lands back on the same pane.
  useEffect(() => {
    const url = active === null ? "/coding" : `/coding?t=${active.terminalId}`;
    window.history.replaceState(null, "", url);
  }, [active]);

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
        description: t("This kills the running process. Its oma history stays on disk."),
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
  }
  function focusTerminal(sel: CodingSelection, terminalId: string): void {
    setSelected(sel);
    setActiveId(terminalId);
    setTabHint(null);
  }
  function openNew(withPrefill: TerminalPrefill | null): void {
    setPrefill(withPrefill);
    setNewOpen("open");
  }

  const running = terminals.filter((row) => row.status === "running").length;
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
    panes = <TerminalPane key={active.terminalId} terminal={active} onClosed={closeById} />;
  }
  if (split) {
    panes = <SplitView terminals={selTerminals} onClosed={closeById} />;
  }

  let main: ReactNode = (
    <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-(--hairline) p-6 text-center text-sm text-(--mute)">
      <div>{t("Pick a worktree on the left to open its terminal.")}</div>
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
        <p className="max-w-md text-[10px]/[1.8]  text-(--faint)">
          {t("This link only locates a view that already exists. Nothing was created.")}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            onClick={() =>
              openNew({
                agentId: entry.agentId ?? undefined,
                projectId: entry.projectId === null ? undefined : entry.projectId,
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
                      projectId: selected.projectId,
                      agentId: selected.agentId,
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
      <PageHeader
        kicker={t("Terminals · every member")}
        title={t("Coding")}
        description={t(
          "A clear work site for code work. Each member's console keeps its own context, and a view keeps running when you leave this page.",
        )}
        actions={
          <Button
            onClick={() =>
              openNew(
                contextFilter.conversationId ||
                  contextFilter.requirementId ||
                  contextFilter.projectId
                  ? {
                      projectId: contextFilter.projectId ?? undefined,
                      conversationId: contextFilter.conversationId ?? undefined,
                      requirementId: contextFilter.requirementId ?? undefined,
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
                          : allTerminals.find(
                              (x) => x.requirementId === contextFilter.requirementId,
                            )?.labels?.requirementTitle,
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
          {t("{open} open views · {running} running", { open: terminals.length, running })}
        </span>
        <span className="flex-1" />
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
          terminals={terminals}
          selected={selected}
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
