import { z } from 'zod';
import { ZodTool } from '../tools/zod-tool';
import type { ToolContext } from '../agent/tool-dispatch/types';
import { debugLog } from '../utils/debug';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const DEDUP_OVERLAP_THRESHOLD = 0.8;
const PERCENT_MULTIPLIER = 100;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/));
  const tokensB = new Set(b.toLowerCase().split(/\s+/));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }
  return intersection / Math.min(tokensA.size, tokensB.size);
}

function expandTilde(filePath: string): string {
  if (filePath.startsWith('~')) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

const createReviewSkillSchema = z.object({
  skill_name: z.string(),
  description: z.string(),
  body: z.string(),
  pitfalls: z.string().optional(),
  scripts: z.record(z.string()).optional(),
  references: z.record(z.string()).optional(),
});

export type CreateReviewSkillParams = z.infer<typeof createReviewSkillSchema>;

export class CreateReviewSkillTool extends ZodTool<typeof createReviewSkillSchema> {
  protected readonly name = 'create_review_skill';
  protected readonly description = 'Create a new skill directory from a review result. Writes SKILL.md with YAML frontmatter, plus optional scripts/ and references/ subdirectories.';
  protected schema = createReviewSkillSchema;

  constructor(private outputDir: string) {
    super();
  }

  protected async handle(params: CreateReviewSkillParams, _ctx: ToolContext): Promise<unknown> {
    if (!SKILL_NAME_RE.test(params.skill_name) || params.skill_name.includes('..')) {
      return { created: false, reason: 'Invalid skill_name: must be 2-49 chars, lowercase alphanumeric and hyphens only, no ".."', skill_name: params.skill_name };
    }

    const dir = expandTilde(this.outputDir);
    const skillDir = path.join(dir, params.skill_name);

    // Dedup: skip if skill directory already exists
    try {
      await fs.access(skillDir);
      debugLog(`Skill already exists, skipping: ${params.skill_name}`);
      return { created: false, reason: 'Skill already exists', skill_name: params.skill_name };
    } catch {
      // Directory does not exist — proceed with creation
    }

    // Dedup: check description overlap against existing skills (>80% skip)
    try {
      const existing = await fs.readdir(dir, { withFileTypes: true });
      const existingDescriptions: string[] = [];
      for (const entry of existing) {
        if (!entry.isDirectory()) continue;
        try {
          const md = await fs.readFile(path.join(dir, entry.name, 'SKILL.md'), 'utf-8');
          const descMatch = /^description:\s*"?([^"\n]+?)"?\s*$/m.exec(md);
          if (descMatch?.[1]) existingDescriptions.push(descMatch[1]);
        } catch {
          // Skip unreadable skills
        }
      }
      for (const existingDesc of existingDescriptions) {
        const overlap = tokenOverlap(params.description, existingDesc);
        if (overlap > DEDUP_OVERLAP_THRESHOLD) {
          debugLog(`Skill description too similar (${(overlap * PERCENT_MULTIPLIER).toFixed(0)}% overlap), skipping`);
          return { created: false, reason: 'Description too similar to existing skill', skill_name: params.skill_name };
        }
      }
    } catch {
      // outputDir may not exist yet — proceed
    }

    try {
      await fs.mkdir(skillDir, { recursive: true });

      // Build SKILL.md content with YAML frontmatter
      const lines: string[] = [
        '---',
        `name: ${params.skill_name}`,
        `description: "${params.description.replace(/"/g, '\\"')}"`,
        '---',
        '',
        params.body,
      ];

      if (params.pitfalls) {
        lines.push('');
        lines.push('## Pitfalls');
        lines.push('');
        lines.push(params.pitfalls);
      }

      // Ensure trailing newline
      lines.push('');

      await fs.writeFile(path.join(skillDir, 'SKILL.md'), lines.join('\n'), 'utf-8');

      // Write scripts subdirectory
      if (params.scripts) {
        const scriptsDir = path.join(skillDir, 'scripts');
        await fs.mkdir(scriptsDir, { recursive: true });
        for (const [filename, content] of Object.entries(params.scripts)) {
          await fs.writeFile(path.join(scriptsDir, filename), content, 'utf-8');
        }
      }

      // Write references subdirectory
      if (params.references) {
        const refsDir = path.join(skillDir, 'references');
        await fs.mkdir(refsDir, { recursive: true });
        for (const [filename, content] of Object.entries(params.references)) {
          await fs.writeFile(path.join(refsDir, filename), content, 'utf-8');
        }
      }

      debugLog(`Created skill: ${params.skill_name}`);
      return { created: true, skill_name: params.skill_name, path: skillDir };
    } catch (error) {
      // Cleanup partially created directory on failure
      await fs.rm(skillDir, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      debugLog(`Failed to create skill ${params.skill_name}: ${message}`);
      return { created: false, reason: message, skill_name: params.skill_name };
    }
  }
}
