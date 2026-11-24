/** The conversation export, as a person reads it (ADR 0040: the ledger is the
 *  truth; the export is that truth in Markdown).
 *
 *  An agent message is a revision with blocks. The export used to print any
 *  revision without a top-level text as raw JSON — a 625 KB file of
 *  `{"messageId":…,"blocks":[…]}` for one room (measured 2026-11-24). Blocks
 *  render as what they are: text as text, a tool call as one line, a result as
 *  a clipped excerpt. Nothing is invented and nothing executable is carried. */

type Block = Record<string, unknown>;
type Revision = Record<string, unknown>;

export function renderRevision(revision: unknown): string {
  if (typeof revision === "string") return revision;
  if (revision === null || typeof revision !== "object") return String(revision);
  const rev = revision as Revision;
  if (typeof rev.text === "string" && rev.text.trim() !== "") return rev.text;
  if (!Array.isArray(rev.blocks)) return "";
  const lines: string[] = [];
  for (const raw of rev.blocks as Block[]) {
    const line = renderBlock(raw);
    if (line !== "") lines.push(line);
  }
  return lines.join("\n\n");
}

function renderBlock(block: Block): string {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "thinking":
      return "";
    case "tool_use": {
      const name = typeof block.name === "string" ? block.name : "tool";
      return `\`→ ${name} ${clip(stringify(block.input), 160)}\``;
    }
    case "tool_result": {
      const content = stringify(block.content);
      const failed = block.isError === true || block.success === false;
      return `> ${failed ? "✗" : "←"} ${clip(content, 400)}`;
    }
    case "image":
      return `[image]`;
    default:
      return "";
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
