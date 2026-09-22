import { useState } from "react";
import { toast } from "sonner";
import { ProjectForm } from "@/components/ProjectForm";
import { useAgentList } from "@/features/agents/hooks";
import { useProjectList, useProjectWorktrees } from "@/features/projects/hooks";
import { type AgentRow, api, type CodingTerminalRow, type ProjectRow } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useCreateTaskWorktree, useSpawnTerminal, useTaskWorktrees } from "../hooks";

export interface CodingSelection {
  projectId: string;
  agentId: string;
}

/** Four-state dot (P2): the oma TUI publishes working/blocked/idle; a
 *  shell pane or a dead process falls back to the plain two-state dot. */
export function terminalDot(term: { status: string; agentState?: string }): {
  mark: string;
  cls: string;
  label: string;
} {
  if (term.status === "exited") {
    return { mark: "○", cls: "text-zinc-500", label: "exited" };
  }
  if (term.agentState === "blocked") {
    return { mark: "◉", cls: "text-amber-500", label: "blocked" };
  }
  if (term.agentState === "working") {
    return { mark: "●", cls: "animate-pulse text-emerald-500", label: "working" };
  }
  if (term.agentState === "idle") {
    return { mark: "○", cls: "text-emerald-700", label: "idle" };
  }
  return { mark: "●", cls: "text-emerald-500", label: "running" };
}
function dotFor(
  terminals: CodingTerminalRow[],
  projectId: string,
  agentId: string,
): { mark: string; cls: string; label: string } {
  const ts = terminals.filter((x) => x.projectId === projectId && x.agentId === agentId);
  if (ts.length === 0) return { mark: "○", cls: "text-zinc-600", label: "" };
  // Roll up the worktree's panes: blocked outranks working outranks a plain
  // running shell outranks idle outranks exited.
  const rank = (x: CodingTerminalRow): number => {
    if (x.agentState === "blocked") return 0;
    if (x.agentState === "working") return 1;
    if (x.status === "running" && !x.agentState) return 2;
    if (x.agentState === "idle") return 3;
    return 4;
  };
  const best = [...ts].sort((a, b) => rank(a) - rank(b))[0]!;
  return terminalDot(best);
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
  const worktrees = data?.worktrees ?? [];
  const spawn = useSpawnTerminal();
  const agents = useAgentList() as { data?: AgentRow[] };
  const { data: taskData } = useTaskWorktrees(project.projectId);
  const taskWorktrees = taskData?.worktrees ?? [];
  const createTask = useCreateTaskWorktree(project.projectId);
  const [slug, setSlug] = useState("");
  const [taskAgent, setTaskAgent] = useState("");

  function open(agentId: string, worktreePath?: string, title?: string) {
    onSelect({ projectId: project.projectId, agentId });
    const has = terminals.some(
      (x) => x.projectId === project.projectId && x.agentId === agentId && x.cwd === worktreePath,
    );
    if (!has) {
      spawn.mutate({
        projectId: project.projectId,
        agentId,
        ...(worktreePath ? { worktreePath, title: title ?? "bash" } : { title: "bash" }),
      });
    }
  }

  async function attachAgent(agentId: string) {
    const agent = agents.data?.find((a) => a.id === agentId);
    if (!agent) return;
    const projects = agent.projects ?? [];
    if (!projects.includes(project.projectId)) {
      try {
        await api.updateAgent(agentId, { projects: [...projects, project.projectId] });
        toast.success(t("Agent attached — worktree materializing"));
      } catch (e) {
        toast.error(t("Attach failed"), { description: String(e) });
      }
    }
  }

  async function createSlugWorktree() {
    const s = slug.trim();
    const agentId = taskAgent || worktrees[0]?.agentId;
    if (!s || !agentId) return;
    try {
      await createTask.mutateAsync({ agentId, slug: s });
      setSlug("");
      toast.success(t("Task worktree created"));
    } catch {
      /* mutation hook already toasts */
    }
  }

  const attached = new Set(worktrees.map((wt) => wt.agentId));
  const attachable = (agents.data ?? []).filter((a) => a.enabled !== false && !attached.has(a.id));

  return (
    <div>
      {worktrees.length === 0 ? (
        <div className="px-3 py-1 text-[11px] text-zinc-500">
          {t("No worktrees yet — attach an agent to materialize one.")}
        </div>
      ) : null}
      {worktrees.map((wt) => {
        const dot = dotFor(terminals, project.projectId, wt.agentId);
        const active = selected?.projectId === project.projectId && selected.agentId === wt.agentId;
        return (
          <button
            key={wt.agentId}
            type="button"
            onClick={() => open(wt.agentId)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-800/60 ${
              active ? "bg-zinc-800" : ""
            }`}
          >
            <span className={dot.cls} title={dot.label}>
              {dot.mark}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-zinc-200">{wt.agentId}</span>
              <span className="block truncate text-[10px] text-zinc-500">
                {project.name} · {wt.worktreeReady ? wt.branch : "not ready"}
                {wt.ahead > 0 ? ` ↑${wt.ahead}` : ""}
              </span>
            </span>
          </button>
        );
      })}
      {/* Task worktrees (the task axis): slug-scoped checkouts beside the
          agent's main worktree. */}
      {taskWorktrees.map((tw) => {
        const active = selected?.projectId === project.projectId && selected.agentId === tw.agentId;
        return (
          <button
            key={`${tw.agentId}:${tw.slug}`}
            type="button"
            onClick={() => open(tw.agentId, tw.path, tw.slug)}
            className={`flex w-full items-center gap-2 py-1 pl-6 pr-3 text-left text-[11px] hover:bg-zinc-800/60 ${
              active ? "bg-zinc-800" : ""
            }`}
          >
            <span className="text-zinc-600">↳</span>
            <span className="min-w-0 flex-1 truncate text-zinc-300">{tw.slug}</span>
            <span className="truncate text-[10px] text-zinc-500">{tw.agentId}</span>
          </button>
        );
      })}
      {/* A worktree is the (agent × project) attach product — this entry is
          how you create one; already-attached agents are filtered out. */}
      {attachable.length > 0 ? (
        <select
          className="mx-3 my-1 w-[calc(100%-1.5rem)] rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-[11px] text-zinc-500"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) void attachAgent(e.target.value);
            e.target.value = "";
          }}
        >
          <option value="">{t("+ attach agent (new worktree)")}</option>
          {attachable.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id}
            </option>
          ))}
        </select>
      ) : null}
      {worktrees.length > 0 ? (
        <div className="flex items-center gap-1 px-3 py-1">
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createSlugWorktree();
            }}
            placeholder={t("task slug (new worktree)")}
            className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-300 placeholder:text-zinc-600"
          />
          {worktrees.length > 1 ? (
            <select
              value={taskAgent}
              onChange={(e) => setTaskAgent(e.target.value)}
              className="max-w-14 rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-[11px] text-zinc-500"
            >
              {worktrees.map((wt) => (
                <option key={wt.agentId} value={wt.agentId}>
                  {wt.agentId}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            onClick={() => void createSlugWorktree()}
            disabled={!slug.trim() || createTask.isPending}
            className="rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
            title={t("git worktree add on a fresh task branch")}
          >
            +
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Herdr-style two halves: spaces (projects) on top, agents (worktrees,
 *  flattened) below. Clicking a worktree row jumps straight to its pane. */
export function CodingRail({
  terminals,
  selected,
  onSelect,
}: {
  terminals: CodingTerminalRow[];
  selected: CodingSelection | null;
  onSelect: (sel: CodingSelection) => void;
}) {
  const { data } = useProjectList();
  const projects = data?.projects ?? [];

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col overflow-y-auto border-r border-zinc-800 bg-zinc-950">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          {t("Projects")}
        </span>
        {/* Reuses the projects page's dialog: one create flow, one
            validation shape, shared query invalidation. */}
        <ProjectForm />
      </div>
      {projects.length === 0 ? (
        <div className="px-3 py-2 text-xs text-zinc-500">
          {t("No projects yet — create one to start coding.")}
        </div>
      ) : null}
      <div className="border-b border-zinc-800 py-1">
        {projects.map((p) => {
          const mine = terminals.filter((x) => x.projectId === p.projectId);
          const blocked = mine.some((x) => x.agentState === "blocked");
          const running = mine.some((x) => x.status === "running");
          return (
            <div key={p.projectId} className="flex items-center gap-2 px-3 py-1 text-xs">
              <span
                className={
                  blocked ? "text-amber-500" : running ? "text-emerald-500" : "text-zinc-600"
                }
              >
                {blocked ? "◉" : running ? "●" : "○"}
              </span>
              <span className="truncate font-medium text-zinc-300">{p.name}</span>
              <span className="ml-auto truncate text-[10px] text-zinc-500">
                {p.defaultBranch ?? "—"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
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
