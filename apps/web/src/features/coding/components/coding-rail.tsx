"use client";

import { GitBranchIcon, TerminalIcon } from "lucide-react";
import { toast } from "sonner";
import { ProjectForm } from "@/components/ProjectForm";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentList } from "@/features/agents/hooks";
import { useProjectList } from "@/features/projects/hooks";
import { api, type CodingTerminalRow, type CodingWorkspaceRow, type ProjectRow } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useSpawnTerminal } from "../hooks";
import { isTaskWorktreeCwd, type LocateSelection } from "../locate";

export type CodingSelection = LocateSelection;

/** Four-state dot (ADR 0029 + ADR 0083 D4): interactive harness panes publish
 *  working/blocked/idle; a shell pane or exited process falls back to running/exited. */
export function terminalDot(term: { status: string; agentState?: string }): {
  mark: string;
  cls: string;
  label: string;
} {
  if (term.status === "exited") {
    return { mark: "○", cls: "text-(--mute)", label: "exited" };
  }
  if (term.agentState === "blocked") {
    return { mark: "◉", cls: "text-(--warn)", label: "blocked" };
  }
  if (term.agentState === "working") {
    return { mark: "●", cls: "animate-pulse text-(--primary)", label: "working" };
  }
  if (term.agentState === "idle") {
    return { mark: "○", cls: "text-(--primary-deep)", label: "idle" };
  }
  return { mark: "●", cls: "text-(--primary)", label: "running" };
}

/** Rolled-up dot for a workspace row (merges active ACP runs + workspace PTY panes). */
export function workspaceDot(state: string): {
  mark: string;
  cls: string;
  label: string;
} {
  if (state === "blocked") return { mark: "◉", cls: "text-(--warn)", label: "blocked" };
  if (state === "working") {
    return { mark: "●", cls: "animate-pulse text-(--primary)", label: "working" };
  }
  if (state === "running") return { mark: "●", cls: "text-(--primary)", label: "running" };
  if (state === "idle") return { mark: "○", cls: "text-(--primary-deep)", label: "idle" };
  if (state === "exited") return { mark: "○", cls: "text-(--mute)", label: "exited" };
  return { mark: "○", cls: "text-(--faint)", label: "" };
}

/** Roll up a group of terminals into one status dot. */
function rollupTerminalsDot(terms: readonly CodingTerminalRow[]): {
  mark: string;
  cls: string;
  label: string;
} {
  if (terms.length === 0) return { mark: "○", cls: "text-(--faint)", label: "" };
  const rank = (x: CodingTerminalRow): number => {
    if (x.status === "running" && x.agentState === "blocked") return 0;
    if (x.status === "running" && x.agentState === "working") return 1;
    if (x.status === "running" && !x.agentState) return 2;
    if (x.status === "running" && x.agentState === "idle") return 3;
    return 4;
  };
  const best = [...terms].sort((a, b) => rank(a) - rank(b))[0];
  return best === undefined ? { mark: "○", cls: "text-(--faint)", label: "" } : terminalDot(best);
}

/** The scope a terminal lives in, for the rail's rows and for focusing it. */
export function selectionOfTerminal(term: CodingTerminalRow): CodingSelection {
  const selection: CodingSelection = { agentId: term.agentId };
  if (term.projectId !== null) selection.projectId = term.projectId;
  if (term.workspaceId) {
    selection.workspaceId = term.workspaceId;
    selection.worktreePath = term.cwd;
  } else if (term.projectId !== null && isTaskWorktreeCwd(term.cwd)) {
    selection.worktreePath = term.cwd;
  }
  if (term.requirementId) selection.requirementId = term.requirementId;
  if (term.conversationId) selection.conversationId = term.conversationId;
  return selection;
}

function selectionOfWorkspace(ws: CodingWorkspaceRow): CodingSelection {
  return {
    workspaceId: ws.workspaceId,
    projectId: ws.projectId,
    agentId: ws.defaultAgentId,
    worktreePath: ws.path,
    ...(ws.requirementId ? { requirementId: ws.requirementId } : {}),
    ...(ws.conversationId ? { conversationId: ws.conversationId } : {}),
  };
}

function ProjectAttachRow({ project }: { project: ProjectRow }) {
  const agentsQuery = useAgentList();
  const agents = agentsQuery.data ?? [];

  async function attachAgent(agentId: string) {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;
    const projects = agent.projects ?? [];
    if (!projects.includes(project.projectId)) {
      try {
        await api.updateAgent(agentId, { projects: [...projects, project.projectId] });
        toast.success(t("Agent attached"));
      } catch (e) {
        toast.error(t("Attach failed"), { description: String(e) });
      }
    }
  }

  const attachable = agents.filter(
    (a) =>
      a.archivedAt === null &&
      a.enabled !== false &&
      !(a.projects ?? []).includes(project.projectId),
  );

  if (attachable.length === 0) return null;

  return (
    <div className="px-3 pb-1.5">
      <Select value="" onValueChange={(v) => void attachAgent(v ?? "")}>
        <SelectTrigger className="h-7 w-full text-[11px]">
          <SelectValue placeholder={t("+ attach agent")} />
        </SelectTrigger>
        <SelectContent>
          {attachable.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name || a.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Herdr-style two-level Coding sidebar (ADR 0083 D5):
 *  1. Requirement workspaces (human title, git branch, rolled-up ACP+PTY dot, nested panes)
 *  2. Agent own workspaces (ADR 0073 `projectId === null` & standalone panes)
 *  3. Projects management (create project & attach agents) */
export function CodingRail({
  workspaces,
  terminals,
  selected,
  activeTerminalId,
  onSelect,
  onFocus,
}: {
  workspaces: CodingWorkspaceRow[];
  terminals: CodingTerminalRow[];
  selected: CodingSelection | null;
  activeTerminalId: string | null;
  onSelect: (sel: CodingSelection) => void;
  onFocus: (sel: CodingSelection, terminalId: string) => void;
}) {
  const projectsQuery = useProjectList();
  const agentsQuery = useAgentList();
  const spawn = useSpawnTerminal();
  const projects = projectsQuery.data === undefined ? [] : projectsQuery.data.projects;
  const agents = agentsQuery.data ?? [];

  const memberNameOf = (agentId: string): string => {
    const agent = agents.find((row) => row.id === agentId);
    return agent === undefined ? agentId : agent.name;
  };

  // Assign terminals to open requirement workspaces first; any remaining panes
  // (ADR 0073 agent own workspaces or legacy project panes) appear in section 2.
  const workspaceTermMap = new Map<string, CodingTerminalRow[]>();
  const assignedTerminalIds = new Set<string>();
  for (const ws of workspaces) {
    const matched = terminals.filter(
      (term) => term.workspaceId === ws.workspaceId || term.cwd === ws.path,
    );
    workspaceTermMap.set(ws.workspaceId, matched);
    for (const term of matched) assignedTerminalIds.add(term.terminalId);
  }

  const standaloneTerminals = terminals.filter((term) => !assignedTerminalIds.has(term.terminalId));
  const standaloneByAgent = new Map<string, CodingTerminalRow[]>();
  for (const term of standaloneTerminals) {
    const bucket = standaloneByAgent.get(term.agentId) ?? [];
    bucket.push(term);
    standaloneByAgent.set(term.agentId, bucket);
  }

  function openWorkspace(ws: CodingWorkspaceRow) {
    const sel = selectionOfWorkspace(ws);
    onSelect(sel);
    const existing = workspaceTermMap.get(ws.workspaceId) ?? [];
    if (existing.length === 0) {
      spawn.mutate({
        projectId: ws.projectId,
        agentId: ws.defaultAgentId,
        workspaceId: ws.workspaceId,
        ...(ws.requirementId ? { requirementId: ws.requirementId } : {}),
        ...(ws.conversationId ? { conversationId: ws.conversationId } : {}),
        title: "bash",
      });
    }
  }

  return (
    <aside className="flex h-full w-68 shrink-0 flex-col overflow-y-auto rounded-xl border border-(--hairline) bg-(--panel)">
      <div className="border-b border-(--hairline) p-3">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.8px] text-(--mute)">
            {t("Workspaces")}
          </h3>
          <span className="font-mono text-[10px] text-(--faint)">{workspaces.length}</span>
        </div>
        {workspaces.length === 0 ? (
          <p className="py-1 text-[11px] leading-[1.7] text-(--mute)">
            {t("No open requirement workspaces yet.")}
          </p>
        ) : (
          <div className="space-y-2 pt-1">
            {workspaces.map((ws) => {
              const dot = workspaceDot(ws.state);
              const children = workspaceTermMap.get(ws.workspaceId) ?? [];
              const wsSelection = selectionOfWorkspace(ws);
              const isSelected =
                selected?.workspaceId === ws.workspaceId ||
                (selected?.worktreePath !== undefined && selected.worktreePath === ws.path);
              const rawFallbackTitle = ws.requirementTitle ?? ws.conversationTitle;
              const compactBranch = ws.branch.replace(/^(req\/[0-9a-f]{8})[0-9a-f]{8,}$/i, "$1…");
              const title = rawFallbackTitle ?? compactBranch;
              const showBranchInSubtitle = rawFallbackTitle !== null;

              return (
                <div
                  key={ws.workspaceId}
                  className={cn(
                    "rounded-lg border transition-colors",
                    isSelected
                      ? "border-(--primary)/40 bg-(--panel2)/80"
                      : "border-transparent bg-(--canvas-soft)/40 hover:border-(--hairline)",
                  )}
                >
                  <Button
                    variant="ghost"
                    onClick={() => openWorkspace(ws)}
                    title={`${ws.branch} (${ws.path})`}
                    className="h-auto w-full items-start justify-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-normal hover:bg-transparent"
                  >
                    <span
                      className={cn("mt-0.5 shrink-0", dot.cls)}
                      title={dot.label ? t(dot.label) : ""}
                    >
                      {dot.mark}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-(--ink)">{title}</span>
                      <span className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-(--mute)">
                        <GitBranchIcon className="size-2.5 shrink-0" />
                        <span className="truncate">
                          {ws.projectName}
                          {showBranchInSubtitle
                            ? ` · ${ws.worktreeReady ? compactBranch : t("not ready")}`
                            : ws.worktreeReady
                              ? ""
                              : ` · ${t("not ready")}`}
                        </span>
                        {ws.ahead > 0 ? (
                          <span className="shrink-0 font-mono text-(--primary)">↑{ws.ahead}</span>
                        ) : null}
                      </span>
                      {ws.pendingActionCount > 0 ? (
                        <span className="mt-1 inline-block rounded-full border border-(--warn)/40 bg-(--warn)/10 px-1.5 py-0.5 text-[9px] font-medium text-(--warn)">
                          {t("Approval needed")} ({ws.pendingActionCount})
                        </span>
                      ) : ws.activeRuns.length > 0 ? (
                        <span className="mt-1 inline-block rounded-full border border-(--primary)/35 bg-(--primary)/10 px-1.5 py-0.5 text-[9px] font-medium text-(--primary)">
                          {t("Worker active")}
                        </span>
                      ) : null}
                    </span>
                  </Button>
                  {children.length > 0 ? (
                    <ul className="space-y-0.5 border-t border-(--hairline)/60 px-2 py-1.5">
                      {children.map((term) => {
                        const termDot = terminalDot(term);
                        const isFocused = activeTerminalId === term.terminalId;
                        return (
                          <li key={term.terminalId}>
                            <Button
                              variant="ghost"
                              onClick={() => onFocus(wsSelection, term.terminalId)}
                              className={cn(
                                "h-auto w-full justify-start gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-normal",
                                isFocused
                                  ? "bg-(--panel) text-(--ink)"
                                  : "text-(--mute) hover:bg-(--panel)/60 hover:text-(--ink)",
                              )}
                            >
                              <span className={termDot.cls} title={t(termDot.label)}>
                                {termDot.mark}
                              </span>
                              <TerminalIcon className="size-3 shrink-0 opacity-60" />
                              <span className="truncate">{term.title}</span>
                              <span className="ml-auto shrink-0 font-mono text-[10px] text-(--faint)">
                                {term.kind === "shell" ? t("shell") : term.kind}
                              </span>
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {standaloneByAgent.size > 0 ? (
        <div className="border-b border-(--hairline) p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.8px] text-(--mute)">
              {t("Agent workspaces")}
            </h3>
            <span className="font-mono text-[10px] text-(--faint)">
              {standaloneTerminals.length}
            </span>
          </div>
          <div className="space-y-2">
            {[...standaloneByAgent.entries()].map(([agentId, group]) => {
              const dot = rollupTerminalsDot(group);
              return (
                <div
                  key={agentId}
                  className="rounded-lg border border-(--hairline)/60 bg-(--canvas-soft)/30 px-2 py-1.5"
                >
                  <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-medium text-(--ink)">
                    <span className={dot.cls} title={dot.label ? t(dot.label) : ""}>
                      {dot.mark}
                    </span>
                    <span className="truncate">{memberNameOf(agentId)}</span>
                  </div>
                  <ul className="space-y-0.5">
                    {group.map((term) => {
                      const termDot = terminalDot(term);
                      const isFocused = activeTerminalId === term.terminalId;
                      return (
                        <li key={term.terminalId}>
                          <Button
                            variant="ghost"
                            onClick={() => onFocus(selectionOfTerminal(term), term.terminalId)}
                            className={cn(
                              "h-auto w-full justify-start gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-normal",
                              isFocused
                                ? "bg-(--panel2) text-(--ink)"
                                : "text-(--mute) hover:bg-(--panel2)/60 hover:text-(--ink)",
                            )}
                          >
                            <span className={termDot.cls} title={t(termDot.label)}>
                              {termDot.mark}
                            </span>
                            <span className="truncate">{term.title}</span>
                            <span className="ml-auto shrink-0 font-mono text-[10px] text-(--faint)">
                              {term.kind === "shell" ? t("shell") : term.kind}
                            </span>
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-(--mute)">
          {t("Projects")}
        </span>
        {/* Reuses the projects page's dialog: one create flow, one
            validation shape, shared query invalidation. */}
        <ProjectForm />
      </div>
      {projects.length === 0 ? (
        <div className="px-3 py-2 text-xs leading-[1.7] text-(--mute)">
          {t("No projects yet — create one to start coding.")}
        </div>
      ) : (
        <div className="pb-2">
          {projects.map((p) => {
            const projectWorkspaces = workspaces.filter((ws) => ws.projectId === p.projectId);
            const blocked = projectWorkspaces.some((ws) => ws.state === "blocked");
            const active = projectWorkspaces.some(
              (ws) => ws.state === "working" || ws.state === "running",
            );
            let mark = "○";
            let markClass = "text-(--faint)";
            if (active) {
              mark = "●";
              markClass = "text-(--primary)";
            }
            if (blocked) {
              mark = "◉";
              markClass = "text-(--warn)";
            }
            return (
              <div key={p.projectId}>
                <div className="flex items-center gap-2 px-3 py-1 text-xs">
                  <span className={markClass}>{mark}</span>
                  <span className="truncate font-medium text-(--ink)">{p.name}</span>
                  <span className="ml-auto truncate text-[10px] text-(--mute)">
                    {p.defaultBranch ?? "—"}
                  </span>
                </div>
                <ProjectAttachRow project={p} />
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
