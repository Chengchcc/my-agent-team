import { useQuery } from "@tanstack/react-query";
import {
  agentSkillPacksQuery,
  skillPackFilesQuery,
  skillPackListQuery,
  skillPackSkillsQuery,
} from "./queries";

export function useSkillPackList() {
  return useQuery(skillPackListQuery());
}

export function useSkillPackSkills(id: string) {
  return useQuery({ ...skillPackSkillsQuery(id), enabled: !!id });
}

export function useSkillPackFiles(id: string, path?: string) {
  return useQuery({ ...skillPackFilesQuery(id, path), enabled: !!id });
}

export function useAgentSkillPacks(agentId: string) {
  return useQuery({ ...agentSkillPacksQuery(agentId), enabled: !!agentId });
}

export {
  useDeletePack,
  useInstallGitPack,
  useSetAgentPacks,
  useSyncPack,
  useUploadZipPack,
} from "./mutations";
export { skillPackKeys } from "./query-keys";
