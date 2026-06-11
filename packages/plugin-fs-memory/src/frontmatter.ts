import { exists, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "fact"
  );
}

export async function writeFact(
  dir: string,
  params: { content: string; tags?: string[] },
): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = slugify(params.content.slice(0, 40));
  let filename = `${ts}-${slug}.md`;
  let filepath = path.join(dir, "facts", filename);

  let n = 2;
  while (await exists(filepath)) {
    filename = `${ts}-${slug}-${n}.md`;
    filepath = path.join(dir, "facts", filename);
    n++;
  }

  const firstLine = params.content.split("\n").find((l) => l.trim()) ?? "";
  const title = firstLine.replace(/^#+\s*/, "").slice(0, 80);

  const tags = JSON.stringify(params.tags ?? []);
  const frontmatter = `---\nts: ${ts}\ntitle: ${JSON.stringify(title)}\ntags: ${tags}\n---\n`;
  await writeFile(filepath, frontmatter + params.content);
  return filepath;
}

export interface Fact {
  path: string;
  title: string;
  tags: string[];
  body: string;
}

export async function readFact(filepath: string): Promise<Fact> {
  const raw = await readFile(filepath, "utf-8");
  const parsed = parseFrontmatter(raw);
  const basename = path.basename(filepath, ".md");
  return {
    path: filepath,
    title: parsed.title ?? basename,
    tags: parsed.tags ?? [],
    body: parsed.body,
  };
}

function parseFrontmatter(raw: string): { title?: string; tags?: string[]; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { body: raw };

  const header = match[1]!;
  const body = match[2]!;

  const titleMatch = header.match(/^title:\s*(.+)$/m);
  const tagsMatch = header.match(/^tags:\s*(\[.*\])$/m);

  let tags: string[] | undefined;
  if (tagsMatch) {
    try {
      tags = JSON.parse(tagsMatch[1]!);
    } catch {
      tags = undefined;
    }
  }

  let title: string | undefined;
  if (titleMatch) {
    try {
      title = JSON.parse(titleMatch[1]!);
    } catch {
      title = titleMatch[1]?.trim();
    }
  }

  return { title, tags, body: body.startsWith("\n") ? body.slice(1) : body };
}
