"use client";

import { XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { AssignToAgentSelect } from "@/components/AssignToAgentSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RoleAvatar, roleKindOf } from "@/components/ui/role-avatar";
import type { AgentRow } from "@/lib/api";
import { t } from "@/lib/i18n";

/** The members a resource is assigned to, with assign and remove. The project editor mounts it
 *  for skill packs; its props are that contract. */
export function PackAgentsTab({
  agents,
  usedBy,
  isAssigned,
  onAssign,
  onRemove,
}: {
  agents: AgentRow[];
  usedBy: AgentRow[];
  isAssigned: (agentId: string) => boolean;
  onAssign: (agentId: string) => void;
  onRemove: (agentId: string) => void;
}) {
  const router = useRouter();

  function openMember(agentId: string): void {
    router.push(`/team/${agentId}`);
  }

  function remove(agentId: string): void {
    onRemove(agentId);
  }

  return (
    <div className="space-y-3">
      <AssignToAgentSelect agents={agents} assigned={isAssigned} onAssign={onAssign} />
      {usedBy.length === 0 ? (
        <p className="text-xs text-(--mute)">{t("Not assigned to any member yet.")}</p>
      ) : (
        usedBy.map((agent) => (
          <div
            key={agent.id}
            className="flex items-center justify-between gap-2 rounded-lg border border-white/6 bg-(--panel) px-3 py-2"
          >
            <Button variant="ghost" size="sm" className="pl-0" onClick={() => openMember(agent.id)}>
              <RoleAvatar kind={roleKindOf(agent)} name={agent.name} size="sm" />
              <span className="truncate text-(--ink)">{agent.name}</span>
            </Button>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant="default">{t("Assigned")}</Badge>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("Remove {name}", { name: agent.name })}
                onClick={() => remove(agent.id)}
              >
                <XIcon />
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
