import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface IdentityData {
  soul: string | null;
  user: string | null;
}

export interface IdentityPatch {
  soul?: string;
  user?: string;
}

export interface AgentIdentityStore {
  getIdentity(agentId: string): Promise<IdentityData>;
  updateIdentity(agentId: string, patch: IdentityPatch): Promise<void>;
}

function isCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === code;
}

/** Read a text file; return null when the file doesn't exist. */
async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (err) {
    if (isCode(err, "ENOENT")) return null;
    throw err;
  }
}

/** Identity files live at the workspace root (SOUL.md, USER.md). Agent
 *  memory is NOT read here: the agent owns it under .oma/memory and injects
 *  it into its own prompt. */

/** A file that is still the SEEDED TEMPLATE is not an identity.
 *
 *  The workspace seeder writes a heading plus a "describe this agent here"
 *  sentence (English in today's seeder, Chinese in older workspaces). Read
 *  verbatim, that sentence lands in the system prompt as if it were a rule and
 *  the model ends up quoting it back. A heading-only body means the operator
 *  has not written anything yet, so the identity is absent - not "some text".
 *  Real content (even one line) is returned unchanged, headings included. */
/** The sentences the seeder has written over time. Both spellings are the
 *  same placeholder: nobody has written an identity yet. */
const TEMPLATE_LINES = new Set([
  "Describe this agent's identity, personality, and behavior guidelines here.",
  "在此描述此 Agent 的身份、人格与行为准则。",
]);

export function identityTextOf(raw: string | null): string | null {
  if (raw === null) return null;
  const body = raw
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !/^\s*#/.test(line) && !TEMPLATE_LINES.has(trimmed);
    })
    .join("")
    .trim();
  return body === "" ? null : raw;
}

export function createAgentIdentityStore(opts: {
  dataDir: string;
  getAgent: (agentId: string) => Promise<{ workspacePath: string }>;
}): AgentIdentityStore {
  return {
    async getIdentity(agentId: string): Promise<IdentityData> {
      const agent = await opts.getAgent(agentId); // validate agent exists
      const root = agent.workspacePath;
      await mkdir(root, { recursive: true });

      const [soulRaw, userRaw] = await Promise.all([
        readTextOrNull(path.join(root, "SOUL.md")),
        readTextOrNull(path.join(root, "USER.md")),
      ]);
      return { soul: identityTextOf(soulRaw), user: identityTextOf(userRaw) };
    },

    async updateIdentity(agentId: string, patch: IdentityPatch): Promise<void> {
      const agent = await opts.getAgent(agentId); // validate agent exists
      const root = agent.workspacePath;
      await mkdir(root, { recursive: true });

      if (typeof patch.soul === "string") {
        await writeFile(path.join(root, "SOUL.md"), patch.soul, "utf-8");
      }
      if (typeof patch.user === "string") {
        await writeFile(path.join(root, "USER.md"), patch.user, "utf-8");
      }
    },
  };
}
