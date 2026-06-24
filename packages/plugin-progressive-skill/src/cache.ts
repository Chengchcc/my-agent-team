import type { AgentFsLike } from "@my-agent-team/tools-common";
import { pjoin } from "@my-agent-team/tools-common";
import matter from "gray-matter";

export interface SkillMeta {
  name: string;
  description: string;
  /** Logical path to the skill directory (e.g. /skills/my-skill) */
  dir: string;
  /** Logical path to the SKILL.md file (e.g. /skills/my-skill/SKILL.md) */
  skillMdPath: string;
  bodyOffset: number;
  /** When true, this skill is excluded from the model's skill index.
   *  It can only be invoked via explicit /skill:name call, not by the model. */
  disableModelInvocation?: boolean;
}

async function loadOneSkillFrontmatter(
  ws: AgentFsLike,
  skillDir: string,
): Promise<SkillMeta | null> {
  const skillMdPath = pjoin(skillDir, "SKILL.md");
  const raw = (await ws.read(skillMdPath)) ?? "";
  if (!raw) return null;
  const parsed = matter(raw);

  if (!parsed.data.name) throw new Error("SKILL.md missing frontmatter.name");

  return {
    name: parsed.data.name as string,
    description: (parsed.data.description as string) ?? "",
    dir: skillDir,
    skillMdPath,
    bodyOffset: raw.length - parsed.content.length,
    disableModelInvocation: parsed.data["disable-model-invocation"] === true,
  };
}

const skillIndexCaches = new Map<string, { skills: SkillMeta[]; mtime: number }>();

export async function loadSkillIndexWithMtimeCache(
  ws: AgentFsLike,
  roots: string[],
  logger?: { warn: (msg: string, err?: unknown) => void },
): Promise<SkillMeta[]> {
  const allSkills: SkillMeta[] = [];
  const seen = new Map<string, number>(); // name → index in allSkills

  for (const root of roots) {
    const dirStat = await ws.stat(root);
    const cached = skillIndexCaches.get(root);
    if (cached && dirStat && cached.mtime === dirStat.mtimeMs) {
      for (const skill of cached.skills) {
        const existingIdx = seen.get(skill.name);
        if (existingIdx !== undefined) {
          allSkills[existingIdx] = skill; // later root overrides
        } else {
          seen.set(skill.name, allSkills.length);
          allSkills.push(skill);
        }
      }
      continue;
    }
    if (cached && !dirStat) {
      for (const skill of cached.skills) {
        const existingIdx = seen.get(skill.name);
        if (existingIdx !== undefined) {
          allSkills[existingIdx] = skill;
        } else {
          seen.set(skill.name, allSkills.length);
          allSkills.push(skill);
        }
      }
      continue;
    }

    const entries = await ws.list(root);
    const results = await Promise.allSettled(
      entries.map((name) => loadOneSkillFrontmatter(ws, pjoin(root, name))),
    );

    const rootSkills: SkillMeta[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === "fulfilled" && r.value) {
        rootSkills.push(r.value);
      } else if (r.status === "rejected") {
        logger?.warn(`skill '${entries[i]}' load failed`, r.reason);
      }
    }

    skillIndexCaches.set(root, { skills: rootSkills, mtime: dirStat?.mtimeMs ?? 0 });

    for (const skill of rootSkills) {
      const existingIdx = seen.get(skill.name);
      if (existingIdx !== undefined) {
        allSkills[existingIdx] = skill;
      } else {
        seen.set(skill.name, allSkills.length);
        allSkills.push(skill);
      }
    }
  }

  return allSkills;
}

export function invalidateSkillCache(root: string): void {
  skillIndexCaches.delete(root);
}
