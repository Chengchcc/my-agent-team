"use client";

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
import { useProjectList, useProjectWorktrees } from "@/features/projects/hooks";
import { api, type CodingTerminalRow, type ProjectRow } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useSpawnTerminal } from "../hooks";
import { isTaskWorktreeCwd } from "../locate";

export interface CodingSelection {
  /** ADR 0073: absent = the agent's OWN workspace (no project worktree). */
  projectId?: string;
  agentId: string;
  /** Task-worktree path (clicking a slug row) — undefined = main worktree. */
  worktreePath?: string;
}

/** Four-state dot (P2): the oma TUI publishes working/blocked/idle; a
 *  shell pane or a dead process falls back to the plain two-state dot. */
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

function dotFor(
  terminals: CodingTerminalRow[],
  projectId: string,
  agentId: string,
): { mark: string; cls: string; label: string } {
  const ts = terminals.filter((x) => x.projectId === projectId && x.agentId === agentId);
  if (ts.length === 0) return { mark: "○", cls: "text-(--faint)", label: "" };
  // Roll up the worktree's panes: blocked outranks working outranks a plain
  // running shell outranks idle outranks exited.
  const rank = (x: CodingTerminalRow): number => {
    if (x.agentState === "blocked") return 0;
    if (x.agentState === "working") return 1;
    if (x.status === "running" && !x.agentState) return 2;
    if (x.agentState === "idle") return 3;
    return 4;
  };
  const best = [...ts].sort((a, b) => rank(a) - rank(b))[0];
  if (best === undefined) return { mark: "○", cls: "text-(--faint)", label: "" };
  return terminalDot(best);
}

/** The scope a terminal lives in, for the rail's rows and for focusing it. */
export function selectionOfTerminal(term: CodingTerminalRow): CodingSelection {
  const selection: CodingSelection = { agentId: term.agentId };
  if (term.projectId !== null) selection.projectId = term.projectId;
  if (term.projectId !== null && isTaskWorktreeCwd(term.cwd)) selection.worktreePath = term.cwd;
  return selection;
}

function ProjectWorktreeRows({
  project,
  terminals,
  selected,
  onSelect,
}: {
  project: ProjectRow;
  terminals: CodingTerminalRow[];
  selected: CodingSelection | null;
  onSelect: (sel: CodingSelection) => void;
}) {
  const { data } = useProjectWorktrees(project.projectId);
  const worktrees = data === undefined ? [] : (data.worktrees ?? []);
  const spawn = useSpawnTerminal();
  const agentsQuery = useAgentList();
  const agents = agentsQuery.data ?? [];

  const defaultAgentId =
    agents.find((a) => a.enabled !== false && a.projects?.includes(project.projectId))?.id ??
    agents.find((a) => a.enabled !== false)?.id ??
    "default";

  /** Opens a terminal in the selected ADR 0077 requirement workspace. */
  function openWorkspace(workspaceId: string, path: string, title: string) {
    const selection: CodingSelection = {
      projectId: project.projectId,
      agentId: defaultAgentId,
      worktreePath: path,
    };
    onSelect(selection);
    const has = terminals.some(
      (x) => x.projectId === project.projectId && (x.workspaceId === workspaceId || x.cwd === path),
    );
    if (!has) {
      spawn.mutate({
        projectId: project.projectId,
        agentId: defaultAgentId,
        workspaceId,
        title,
      });
    }
  }

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
    (a) => a.enabled !== false && !(a.projects ?? []).includes(project.projectId),
  );

  return (
    <div>
      {worktrees.length === 0 ? (
        <div className="px-3 py-1 text-[11px] leading-[1.7] text-(--mute)">
          {t("No open requirement workspaces yet.")}
        </div>
      ) : null}
      {worktrees.map((wt) => {
        const dot = dotFor(terminals, project.projectId, defaultAgentId);
        const active =
          selected?.projectId === project.projectId && selected.worktreePath === wt.path;
        const label = wt.requirementId
          ? wt.requirementId.slice(0, 12)
          : wt.workspaceId.slice(0, 12);
        return (
          <Button
            key={wt.workspaceId}
            variant="ghost"
            onClick={() => openWorkspace(wt.workspaceId, wt.path, wt.branch)}
            title={`${wt.branch} (${wt.path})`}
            className={`h-auto w-full justify-start gap-2 rounded-md px-3 py-1.5 text-left text-xs font-normal hover:bg-(--panel2) ${
              active ? "bg-(--panel2)" : ""
            }`}
          >
            <span className={dot.cls} title={dot.label}>
              {dot.mark}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-(--ink)">{label}</span>
              <span className="block truncate text-[10px] text-(--mute)">
                {project.name} · {wt.worktreeReady ? wt.branch : t("not ready")}
                {wt.ahead > 0 ? ` ↑${wt.ahead}` : ""}
              </span>
            </span>
          </Button>
        );
      })}
      {attachable.length > 0 ? (
        <div className="px-3 py-1">
          <Select value="" onValueChange={(v) => void attachAgent(v ?? "")}>
            <SelectTrigger className="h-7 w-full text-[11px]">
              <SelectValue placeholder={t("+ attach agent")} />
            </SelectTrigger>
            <SelectContent>
              {attachable.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </div>
  );
}

/** One existing terminal in the inventory: where it lives, who it belongs to, how it is. Focus
 *  only locates it; it never creates anything. */
function InventoryRow({
  term,
  project,
  member,
  onFocus,
}: {
  term: CodingTerminalRow;
  project: ProjectRow | undefined;
  member: string;
  onFocus: (term: CodingTerminalRow) => void;
}) {
  const dot = terminalDot(term);
  let scope = t("Own workspace");
  if (project !== undefined) {
    scope = isTaskWorktreeCwd(term.cwd)
      ? `${project.name} · ${term.cwd.split(".").pop()}`
      : project.name;
  }
  return (
    <li className="border-b border-(--hairline) py-3 last:border-b-0">
      <strong className="block text-[11px] font-[550] wrap-anywhere text-(--ink)">
        {term.title}
      </strong>
      <small className="block text-[10px] leading-[1.7] text-(--mute)">
        {scope} · {member}
      </small>
      <small className="block text-[10px] leading-[1.7] text-(--mute)">
        <span className={dot.cls} title={t(dot.label)}>
          {dot.mark}
        </span>{" "}
        {t(term.status)} · {term.kind === "oma" ? "oma" : t("shell")}
      </small>
      <Button variant="link" className="mt-2 text-[10px]" onClick={() => onFocus(term)}>
        {t("Focus")}
      </Button>
    </li>
  );
}

/** The terminal inventory on top, then the projects and their worktrees. Clicking a worktree
 *  row opens its scope and starts a terminal there when it has none; Focus only locates. */
export function CodingRail({
  terminals,
  selected,
  onSelect,
  onFocus,
}: {
  terminals: CodingTerminalRow[];
  selected: CodingSelection | null;
  onSelect: (sel: CodingSelection) => void;
  onFocus: (sel: CodingSelection, terminalId: string) => void;
}) {
  const projectsQuery = useProjectList();
  const agentsQuery = useAgentList();
  const projects = projectsQuery.data === undefined ? [] : projectsQuery.data.projects;
  const agents = agentsQuery.data ?? [];
  const memberOf = (term: CodingTerminalRow): string => {
    const agent = agents.find((row) => row.id === term.agentId);
    return agent === undefined ? term.agentId : agent.name;
  };

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col overflow-y-auto rounded-xl border border-(--hairline) bg-(--panel)">
      <div className="border-b border-(--hairline) p-[15px] ">
        <h3 className="mb-1 font-mono text-[11px] tracking-[0.8px] text-(--mute)">
          {t("Terminals · all")}
        </h3>
        <p className="mb-2 text-[10px] leading-[1.7] text-(--faint)">
          {t("Focus only brings a view to the front. It never creates a terminal.")}
        </p>
        {terminals.length === 0 ? (
          <p className="text-[11px] leading-[1.7] text-(--mute)">
            {t("No terminal yet. New terminal starts one.")}
          </p>
        ) : (
          <ul>
            {terminals.map((term) => (
              <InventoryRow
                key={term.terminalId}
                term={term}
                project={projects.find((p) => p.projectId === term.projectId)}
                member={memberOf(term)}
                onFocus={(term) => onFocus(selectionOfTerminal(term), term.terminalId)}
              />
            ))}
          </ul>
        )}
      </div>

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
      ) : null}
      <div className="border-b border-(--hairline) py-1">
        {projects.map((p) => {
          const mine = terminals.filter((x) => x.projectId === p.projectId);
          const blocked = mine.some((x) => x.agentState === "blocked");
          const running = mine.some((x) => x.status === "running");
          // Blocked outranks running when a project's panes are rolled up into one mark.
          let mark = "○";
          let markClass = "text-(--faint)";
          if (running) {
            mark = "●";
            markClass = "text-(--primary)";
          }
          if (blocked) {
            mark = "◉";
            markClass = "text-(--warn)";
          }
          return (
            <div key={p.projectId} className="flex items-center gap-2 px-3 py-1 text-xs">
              <span className={markClass}>{mark}</span>
              <span className="truncate font-medium text-(--ink)">{p.name}</span>
              <span className="ml-auto truncate text-[10px] text-(--mute)">
                {p.defaultBranch ?? "—"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-(--mute)">
        {t("Worktrees")}
      </div>
      <div className="min-h-0 flex-1">
        {projects.map((p) => (
          <ProjectWorktreeRows
            key={p.projectId}
            project={p}
            terminals={terminals}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
      </div>
    </aside>
  );
}
