import { api } from "@/lib/api";
import { skillPackKeys } from "./query-keys";

export function skillPackListQuery() {
  return {
    queryKey: skillPackKeys.list(),
    queryFn: () => api.listSkillPacks(),
  };
}

export function skillPackSkillsQuery(id: string) {
  return {
    queryKey: skillPackKeys.skills(id),
    queryFn: () => api.getSkillPackSkills(id),
    enabled: !!id,
  };
}

export function skillPackFilesQuery(id: string, path?: string) {
  return {
    queryKey: skillPackKeys.files(id, path),
    queryFn: () => api.getSkillPackFiles(id, path),
    enabled: !!id,
  };
}

export function agentSkillPacksQuery(agentId: string) {
  return {
    queryKey: skillPackKeys.agentPacks(agentId),
    queryFn: () => api.getAgentSkillPacks(agentId),
    enabled: !!agentId,
  };
}
