import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { SkillCommand } from "@/lib/slash-commands";
import type { PackCheck } from "./pack-model";
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

/** The `/` entries for the skills an agent can load: those of its packs that are ready on disk. */
export function agentSkillCommandsQuery(agentId: string) {
  return {
    queryKey: skillPackKeys.agentCommands(agentId),
    queryFn: async (): Promise<SkillCommand[]> => {
      const packs = await api.getAgentSkillPacks(agentId);
      const ready = packs.filter((pack) => pack.status === "ready");
      const skills = await Promise.all(ready.map((pack) => api.getSkillPackSkills(pack.id)));
      return skills
        .flat()
        .map((skill) => ({ command: `/${skill.name}`, description: skill.description }));
    },
    enabled: !!agentId,
    staleTime: 60_000,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as T;
  return data;
}

/** The integrity check of every pack, asked for by hand. It is the only read that looks at the
 *  disk, so "Check" is a button and the result stays until it is run again. */
export function skillPackValidateQuery() {
  return queryOptions({
    queryKey: skillPackKeys.validate(),
    queryFn: async (): Promise<PackCheck[]> => {
      const response = await fetch("/api/bff/skill-packs/validate", {
        credentials: "include",
      });
      const data = await readJson<{ packs: PackCheck[] }>(response);
      return data.packs;
    },
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** The lockfile as the backend writes it. Fetched when its dialog opens. */
export function skillPackLockfileQuery() {
  return queryOptions({
    queryKey: skillPackKeys.lockfile(),
    queryFn: async (): Promise<unknown> => {
      const response = await fetch("/api/bff/skill-packs/lockfile", {
        credentials: "include",
      });
      const data = await readJson<unknown>(response);
      return data;
    },
    enabled: false,
  });
}
