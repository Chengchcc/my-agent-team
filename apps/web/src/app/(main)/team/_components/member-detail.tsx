"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { IdentityPanel } from "@/components/IdentityPanel";
import { AgentRunsTable } from "@/components/ops/AgentRunsTable";
import { QueryState } from "@/components/ops/QueryState";
import { UsagePanel } from "@/components/UsagePanel";
import { Button } from "@/components/ui/button";
import { WorkspaceExplorer } from "@/components/WorkspaceExplorer";
import { useConversationList } from "@/features/conversations/hooks";
import { LarkSurfacePanel } from "@/features/lark/LarkSurfacePanel";
import { useMcpCatalog } from "@/features/mcp/hooks";
import { useAgentRuns } from "@/features/ops/hooks";
import { useProjectList } from "@/features/projects/hooks";
import { useAgentSkillPacks, useSkillPackList } from "@/features/skill-packs/hooks";
import type { AgentRow } from "@/lib/api";
import { conversationDisplayName } from "@/lib/conversation-title";
import { t } from "@/lib/i18n";
import { AgentProjectsPanel } from "./agent-projects-panel";

export type MemberTab =
  | "overview"
  | "capability"
  | "workspace"
  | "persona"
  | "projects"
  | "lark"
  | "activity"
  | "conversations"
  | "config";

const TABS: ReadonlyArray<{ id: MemberTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "capability", label: "Capability" },
  { id: "workspace", label: "Workspace" },
  { id: "persona", label: "Persona" },
  { id: "projects", label: "Projects" },
  { id: "lark", label: "Lark" },
  { id: "activity", label: "Activity" },
  { id: "conversations", label: "Conversations" },
  { id: "config", label: "Config" },
];

/** Every tab of the member detail. The labels are translated where they are shown. */
export const MEMBER_TABS = TABS;

export function memberTabOf(value: string | null): MemberTab {
  const found = TABS.find((tab) => tab.id === value);
  if (found === undefined) return "overview";
  return found.id;
}

const ORIGIN_LABEL: Record<string, string> = {
  user: "Direct",
  fork: "Forked",
  dispatch: "Dispatched",
  workflow: "Workflow",
};

function originLabel(origin: string): string {
  const label = ORIGIN_LABEL[origin];
  if (label === undefined) return origin;
  return t(label);
}

const noteClass = "text-[11px] leading-relaxed text-(--mute)";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-(--hairline) p-4">
      <h3 className="mb-3 text-sm font-medium text-(--ink)">{title}</h3>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-xs/relaxed  sm:grid-cols-[120px_minmax(0,1fr)]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-(--mute)">{label}</dt>
          <dd className="wrap-break-word text-(--ink)">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One thing a member is bound to: a skill pack, an MCP server, a capability entry. */
function Binding({ name, lines }: { name: string; lines: ReadonlyArray<string> }) {
  return (
    <div className="border-t border-(--hairline) py-2.5 first:border-t-0">
      <p className="text-xs font-medium wrap-break-word text-(--ink)">{name}</p>
      {lines.map((line) => (
        <p key={line} className="text-[10px] leading-relaxed break-all text-(--mute)">
          {line}
        </p>
      ))}
    </div>
  );
}

function OverviewTab({ agent }: { agent: AgentRow }) {
  const { data } = useProjectList();
  const names = (agent.projects ?? []).map((id) => {
    const project = data?.projects.find((row) => row.projectId === id);
    if (project === undefined) return id;
    return project.name;
  });
  const paused = agent.enabled === false;
  const kind =
    agent.role === "worker"
      ? t("Worker type · runs the work dispatched to it")
      : t("PA type · talks with people and dispatches work");
  return (
    <div className="space-y-4">
      <Facts
        rows={[
          [t("Member role"), kind],
          [
            t("Receiving new work"),
            paused
              ? t("Paused: left out of what the PA discovers and dispatches to.")
              : t("Enabled: the PA can discover it and dispatch to it."),
          ],
          [t("Projects"), names.length === 0 ? t("None") : names.join(", ")],
          [
            t("Configured"),
            agent.updatedAt === null || agent.updatedAt === undefined
              ? t("Not available")
              : new Date(agent.updatedAt).toLocaleString(),
          ],
        ]}
      />
      <Section title={t("Capability card")}>
        <p className={noteClass}>
          {t(
            "Name, description and capability entries describe the work this member is for. What is mounted does not by itself authorize anything.",
          )}
        </p>
        <div className="mt-3">
          <Binding
            name={agent.name}
            lines={[agent.description ?? t("No capability description yet.")]}
          />
          {agent.skills.length === 0 && (
            <p className="mt-2 text-[11px] text-(--mute)">
              {t("No capability entries declared; the description stands.")}
            </p>
          )}
          {agent.skills.map((skill) => (
            <Binding
              key={skill.id}
              name={skill.id}
              lines={[skill.description === "" ? t("No description") : skill.description]}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}

function CapabilityTab({ agent }: { agent: AgentRow }) {
  const { data: allPacks } = useSkillPackList();
  const { data: assigned } = useAgentSkillPacks(agent.id);
  const { data: mcpCatalog } = useMcpCatalog();
  const catalog: { serverId: string; name: string }[] = mcpCatalog?.mcpServers ?? [];
  const assignedIds = new Set((assigned ?? []).map((pack) => pack.id));
  const packs = (allPacks ?? []).filter((pack) => assignedIds.has(pack.id));
  const servers = (agent.mcpServers ?? []).map((row) => {
    const known = catalog.find((server) => server.serverId === row.serverId);
    const name = known === undefined ? row.serverId : known.name;
    const lines = [row.serverId, row.enabled ? t("mounted") : t("paused")];
    if (known === undefined) lines.push(t("No longer in the catalog"));
    return { name, lines };
  });
  return (
    <div className="space-y-4">
      <Section title={t("Skill packs · assigned")}>
        <p className={noteClass}>
          {t(
            "What is assigned to this member. Registration and whether it is on disk are separate states, shown on the Skills page.",
          )}
        </p>
        <div className="mt-2">
          {packs.length === 0 && (
            <p className="text-xs text-(--mute)">{t("No skill pack assigned.")}</p>
          )}
          {packs.map((pack) => (
            <Binding key={pack.id} name={pack.name} lines={[pack.id, pack.status]} />
          ))}
        </div>
        <Link
          href="/team/skills"
          className="mt-3 inline-block text-[11px] text-(--primary) hover:underline"
        >
          {t("Manage skill packs")}
        </Link>
      </Section>
      <Section title={t("MCP · bound")}>
        <div className="mt-1">
          {servers.length === 0 && (
            <p className="text-xs text-(--mute)">{t("No MCP server bound.")}</p>
          )}
          {servers.map((server) => (
            <Binding key={server.lines[0] ?? server.name} name={server.name} lines={server.lines} />
          ))}
        </div>
        <Link
          href="/team/mcp"
          className="mt-3 inline-block text-[11px] text-(--primary) hover:underline"
        >
          {t("Manage MCP")}
        </Link>
      </Section>
      <Section title={t("Harness · run configuration")}>
        <Facts
          rows={[
            [t("Harness"), agent.harness],
            [
              t("Model"),
              agent.model === "" || agent.model === null ? t("Harness default") : agent.model,
            ],
            [t("Permission mode"), agent.permissionMode],
            [
              t("Reasoning effort"),
              agent.reasoningEffort === null ? t("Provider default") : agent.reasoningEffort,
            ],
            [t("Max steps"), agent.maxSteps === null ? t("Unlimited") : String(agent.maxSteps)],
          ]}
        />
        <p className={`mt-3 ${noteClass}`}>
          {t(
            "The configuration the run starts from. It is not a record of what a run was allowed to do.",
          )}
        </p>
      </Section>
    </div>
  );
}

function ActivityTab({ agentId }: { agentId: string }) {
  const runsQuery = useAgentRuns({ agentId, limit: 50 });
  return (
    <div className="space-y-4">
      <Section title={t("Usage")}>
        <UsagePanel agentId={agentId} />
      </Section>
      <Section title={t("Recent runs")}>
        <p className={`mb-3 ${noteClass}`}>
          {t("Last 50 runs of this member, across every room.")}
        </p>
        <QueryState
          query={runsQuery}
          empty={(data) => data.runs.length === 0}
          emptyMessage={t("No recent runs.")}
        >
          {(data) => (
            <AgentRunsTable
              runs={data.runs.map((run) => ({
                runId: run.runId,
                status: run.status,
                agentId: run.agentId ?? "",
                model: run.model.modelId,
                createdAt: run.createdAt,
                terminalAt: run.terminalAt,
                usage: run.usage ?? null,
                error: run.error ?? null,
              }))}
              onCancel={() => {}}
            />
          )}
        </QueryState>
      </Section>
    </div>
  );
}

function ConversationsTab({ agent }: { agent: AgentRow }) {
  const { data, isLoading } = useConversationList(agent.id);
  if (isLoading) return <p className="text-xs text-(--mute)">{t("Loading conversations…")}</p>;
  const rows = [...(data ?? [])].sort(
    (a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt),
  );
  if (rows.length === 0) {
    return <p className={noteClass}>{t("This member has no conversation yet.")}</p>;
  }
  return (
    <ul className="space-y-1.5">
      {rows.map((row) => (
        <li key={row.conversationId}>
          <Link
            href={`/chat/${encodeURIComponent(row.conversationId)}`}
            className="flex items-center gap-3 rounded-lg border border-(--hairline) px-3 py-2 transition-colors hover:border-(--primary)"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-(--ink)">
                {conversationDisplayName(row)}
              </span>
              <span className="block truncate font-mono text-[10px] text-(--mute)">
                {originLabel(row.origin)} · {row.conversationId}
              </span>
            </span>
            <span className="shrink-0 text-[10px] text-(--primary)">{t("Open")}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export interface MemberDetailProps {
  agent: AgentRow;
  tab: MemberTab;
  onEdit: () => void;
}

/** The saved state of one member, tab by tab. Reading it changes nothing; the panels that can
 *  write (identity, memory, projects) do so only on their own explicit Save or toggle. */
export function MemberDetail({ agent, tab, onEdit }: MemberDetailProps) {
  const agentId = agent.id;
  switch (tab) {
    case "capability":
      return <CapabilityTab agent={agent} />;
    case "workspace":
      return <WorkspaceExplorer agentId={agentId} />;
    case "persona":
      return <IdentityPanel agentId={agentId} />;
    case "projects":
      return <AgentProjectsPanel agent={agent} />;
    case "lark":
      return <LarkTab agent={agent} />;
    case "activity":
      return <ActivityTab agentId={agentId} />;
    case "conversations":
      return <ConversationsTab agent={agent} />;
    case "config":
      return <ConfigTab agent={agent} onEdit={onEdit} />;
    default:
      return <OverviewTab agent={agent} />;
  }
}

function LarkTab({ agent }: { agent: AgentRow }) {
  if (agent.role === "worker") {
    return (
      <div>
        <Facts
          rows={[
            [
              t("Lark entry"),
              t("Not applicable: a worker takes no direct instruction from people."),
            ],
          ]}
        />
        <p className={`mt-3 ${noteClass}`}>{t("Work reaches a worker by dispatch.")}</p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <LarkSurfacePanel agentId={agent.id} />
    </div>
  );
}

function ConfigTab({ agent, onEdit }: { agent: AgentRow; onEdit: () => void }) {
  return (
    <div className="space-y-3">
      <pre className="max-h-[460px] overflow-auto rounded-xl border border-(--hairline) bg-(--canvas) p-4 font-mono text-[11px] leading-relaxed break-all text-(--ink)">
        {JSON.stringify(agent, null, 2)}
      </pre>
      <p className={noteClass}>
        {t(
          "The member as the registry holds it now. Edits go through the form, with a PA beside it.",
        )}
      </p>
      <Button variant="outline" size="sm" onClick={onEdit}>
        {t("Edit settings")}
      </Button>
    </div>
  );
}
