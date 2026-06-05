import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

export interface SkillMeta {
  name: string;
  description: string;
  dir: string;
  skillMdPath: string;
  bodyOffset: number;
}

async function loadOneSkillFrontmatter(dir: string): Promise<SkillMeta | null> {
  const skillMdPath = path.join(dir, "SKILL.md");
  const raw = await readFile(skillMdPath, "utf-8");
  const parsed = matter(raw);

  if (!parsed.data.name) throw new Error("SKILL.md missing frontmatter.name");

  return {
    name: parsed.data.name as string,
    description: (parsed.data.description as string) ?? "",
    dir,
    skillMdPath,
    bodyOffset: raw.length - parsed.content.length,
  };
}

const skillIndexCaches = new Map<string, { skills: SkillMeta[]; mtime: number }>();

export async function loadSkillIndexWithMtimeCache(
  dir: string,
  logger?: { warn: (msg: string, err?: unknown) => void },
): Promise<SkillMeta[]> {
  const dirStat = await stat(dir);
  const cached = skillIndexCaches.get(dir);
  if (cached && cached.mtime === dirStat.mtimeMs) {
    return cached.skills;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  const results = await Promise.allSettled(
    dirs.map((d) => loadOneSkillFrontmatter(path.join(dir, d.name))),
  );

  const skills: SkillMeta[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "fulfilled" && r.value) {
      skills.push(r.value);
    } else if (r.status === "rejected") {
      logger?.warn(`skill '${dirs[i]?.name}' load failed`, r.reason);
    }
  }

  skillIndexCaches.set(dir, { skills, mtime: dirStat.mtimeMs });
  return skills;
}

export function invalidateSkillCache(dir: string): void {
  skillIndexCaches.delete(dir);
}
