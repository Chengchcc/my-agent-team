"use client";

import { useAgentList } from "@/features/agents/hooks";
import { useProjectList } from "@/features/projects/hooks";
import { t } from "@/lib/i18n";

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="min-w-16">
      <dd className="text-[29px] leading-[1.4] font-[550] tracking-[-1px] text-(--ink)">{value}</dd>
      <dt className="mt-1 text-[10px] uppercase tracking-[1.8px] text-(--faint)">{label}</dt>
    </div>
  );
}

/** Two counts over the real registry: registered projects and team members. */
export function ProjectsStats() {
  const { data: projects } = useProjectList();
  const { data: agents } = useAgentList();
  return (
    <dl className="flex shrink-0 gap-8">
      <Stat value={projects?.projects.length ?? 0} label={t("Projects")} />
      <Stat value={agents?.length ?? 0} label={t("Team members")} />
    </dl>
  );
}
