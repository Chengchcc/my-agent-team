"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RoleAvatar, type RoleKind, roleKindOf } from "@/components/ui/role-avatar";
import { agentSkillPacksQuery } from "@/features/skill-packs/queries";
import type { AgentRow } from "@/lib/api";
import { t } from "@/lib/i18n";

/** The faint tint in a card's corner, in the colour of the member's role. */
const TINT_CLASS: Record<RoleKind, string> = {
  pa: "bg-(--accent-violet)/10",
  worker: "bg-(--primary)/10",
  reviewer: "bg-(--warn)/10",
  research: "bg-(--info)/10",
  user: "bg-white/5",
};

const metaLabel = "mb-1 block text-[10px] text-(--mute)";
const metaValue = "block text-[11px] font-medium break-all text-(--ink)";

/** What the member's role is called, and the one line that says how it works. */
function roleLine(agent: AgentRow): { title: string; kind: string; explanation: string } {
  if (agent.role === "worker") {
    return {
      title: t("Worker"),
      kind: t("Worker type"),
      explanation: t("runs the work dispatched to it"),
    };
  }
  return {
    title: t("PA"),
    kind: t("PA type"),
    explanation: t("talks with people and dispatches work"),
  };
}

export interface MemberCardProps {
  agent: AgentRow;
  /** The harness's display name; the registry key when the probe does not know it. */
  harnessName: string;
  /** Root conversations this member owns. */
  conversations: number;
  onView: () => void;
  onEdit: () => void;
  /** Pause an enabled member, or enable a paused one. */
  onToggle: () => void;
}

/** One member of the registry: who it is, what it is configured with, and the three things a
 *  person does from here. What is configured is what the card shows; it is not what a run is
 *  authorized to do. */
export function MemberCard({
  agent,
  harnessName,
  conversations,
  onView,
  onEdit,
  onToggle,
}: MemberCardProps) {
  const kind = roleKindOf(agent);
  const role = roleLine(agent);
  const paused = agent.enabled === false;
  const packsQuery = useQuery(agentSkillPacksQuery(agent.id));
  const packs = Array.isArray(packsQuery.data) ? packsQuery.data.length : 0;

  return (
    <article
      data-slot="member-card"
      data-member-id={agent.id}
      className="relative min-w-0 overflow-hidden rounded-2xl border border-(--hairline) bg-(--panel) p-5"
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute -top-20 right-0 size-60 rounded-full blur-3xl ${TINT_CLASS[kind]}`}
      />
      <div className="relative flex items-center gap-3">
        <RoleAvatar kind={kind} name={agent.name} />
        <span className="flex-1" />
        <Badge variant={paused ? "wait" : "default"}>{paused ? t("paused") : t("enabled")}</Badge>
      </div>
      <h3 className="relative mt-4 text-xl/tight  font-medium wrap-break-word text-(--ink-strong)">
        {agent.name}
      </h3>
      <p className="relative mt-1 text-[11px] text-(--primary)">
        {role.title} · {role.kind} · {role.explanation}
      </p>
      <p className="relative mt-3 min-h-11 text-xs/relaxed  wrap-break-word text-(--body)">
        {agent.description === null || agent.description === ""
          ? t("No capability description yet.")
          : agent.description}
      </p>

      <dl className="relative mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-y border-(--hairline) py-3">
        <div className="min-w-0">
          <dt className={metaLabel}>{t("Harness · configured")}</dt>
          <dd className={metaValue}>{harnessName}</dd>
        </div>
        <div className="min-w-0">
          <dt className={metaLabel}>{t("Model")}</dt>
          <dd className={`${metaValue} font-mono`}>
            {agent.model === "" || agent.model === null ? t("Harness default") : agent.model}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className={metaLabel}>{t("Member workspace")}</dt>
          <dd className={`${metaValue} font-mono`}>{agent.workspacePath}</dd>
        </div>
        <div className="min-w-0">
          <dt className={metaLabel}>{t("Work context")}</dt>
          <dd className={metaValue}>{t("{n} conversations", { n: conversations })}</dd>
        </div>
      </dl>

      <div className="relative mt-3 flex flex-wrap gap-1.5">
        <Badge variant="secondary">{t("Capability entries {n}", { n: agent.skills.length })}</Badge>
        <Badge variant="secondary">{t("Skill packs {n}", { n: packs })}</Badge>
        <Badge variant="secondary">MCP {agent.mcpServers?.length ?? 0}</Badge>
        <Badge variant="secondary">{t("Projects {n}", { n: agent.projects?.length ?? 0 })}</Badge>
      </div>

      <div className="relative mt-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onView}>
          {t("View")}
        </Button>
        <Button variant="outline" size="sm" onClick={onEdit}>
          {t("Edit settings")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          aria-pressed={agent.enabled !== false}
          onClick={onToggle}
        >
          {paused ? t("Enable for new work") : t("Pause new work")}
        </Button>
      </div>
      <p className="relative mt-3 text-[10px] leading-relaxed text-(--faint)">
        {t("Skills, MCP and harness say what is configured, not what a run is authorized to do.")}
      </p>
    </article>
  );
}
