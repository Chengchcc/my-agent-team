import type { AgentFsLike } from "@my-agent-team/tools-common";
import { pjoin } from "@my-agent-team/tools-common";

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "fact"
  );
}

export async function writeFact(
  ws: AgentFsLike,
  root: string,
  params: { content: string; tags?: string[] },
): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = slugify(params.content.slice(0, 40));
  let filename = `${ts}-${slug}.md`;
  let filepath = pjoin(root, "facts", filename);
  let n = 2;
  while (await ws.exists(filepath)) {
    filename = `${ts}-${slug}-${n}.md`;
    filepath = pjoin(root, "facts", filename);
    n++;
  }
  const firstLine = params.content.split("\n").find((l) => l.trim()) ?? "";
  const title = firstLine.replace(/^#+\s*/, "").slice(0, 80);
  const tags = JSON.stringify(params.tags ?? []);
  await ws.write(
    filepath,
    `---\nts: ${ts}\ntitle: ${JSON.stringify(title)}\ntags: ${tags}\n---\n${params.content}`,
  );
  return filepath;
}

export interface Fact {
  path: string;
  title: string;
  tags: string[];
  body: string;
}

export async function readFact(ws: AgentFsLike, filepath: string): Promise<Fact> {
  const raw = (await ws.read(filepath)) ?? "";
  const parsed = parseFrontmatter(raw);
  const basename = filepath.split("/").pop()?.replace(/\.md$/, "") ?? "";
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
  const h = match[1]!,
    b = match[2]!;
  let tags: string[] | undefined;
  const tm = h.match(/^tags:\s*(\[.*\])$/m);
  if (tm) {
    try {
      tags = JSON.parse(tm[1]!);
    } catch {
      tags = undefined;
    }
  }
  let title: string | undefined;
  const ttl = h.match(/^title:\s*(.+)$/m);
  if (ttl) {
    try {
      title = JSON.parse(ttl[1]!);
    } catch {
      title = ttl[1]?.trim();
    }
  }
  return { title, tags, body: b.startsWith("\n") ? b.slice(1) : b };
}
