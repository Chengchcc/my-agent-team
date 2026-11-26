import { useQuery } from "@tanstack/react-query";
import { hiddenSegment } from "./pack-model";
import {
  agentSkillPacksQuery,
  skillPackFilesQuery,
  skillPackListQuery,
  skillPackLockfileQuery,
  skillPackSkillsQuery,
  skillPackValidateQuery,
} from "./queries";

export function useSkillPackList() {
  return useQuery(skillPackListQuery());
}

/** The skills of a pack. Nothing is requested while it is not materialized: the backend would
 *  answer 404, and the page says the files are unavailable instead. */
export function useSkillPackSkills(id: string, options: { readable: boolean }) {
  return useQuery({ ...skillPackSkillsQuery(id), enabled: options.readable && id !== "" });
}

/** One directory of a pack. Never asks for a path with a hidden segment. */
export function useSkillPackFiles(id: string, path: string, options: { readable: boolean }) {
  const allowed = options.readable && hiddenSegment(path === "" ? "root" : path) === null;
  return useQuery({ ...skillPackFilesQuery(id, path === "" ? undefined : path), enabled: allowed });
}

export function useAgentSkillPacks(agentId: string) {
  return useQuery({ ...agentSkillPacksQuery(agentId), enabled: !!agentId });
}

/** The last integrity check. Empty until "Check" asks for it with `refetch`. */
export function useSkillPackValidate() {
  const options = skillPackValidateQuery();
  return useQuery(options);
}

export function useSkillPackLockfile() {
  const options = skillPackLockfileQuery();
  return useQuery(options);
}

export {
  useDeletePack,
  useInstallGitPack,
  useSetAgentPacks,
  useSetAgentsPacks,
  useSyncPack,
  useUploadZipPack,
} from "./mutations";
export { skillPackKeys } from "./query-keys";
