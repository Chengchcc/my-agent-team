// src/profile/update-identity-tool.ts
// Tool that lets the agent update its own identity files (SOUL.md, IDENTITY.md, AGENTS.md)
// and reload them into the system prompt.

import { z } from 'zod';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZodTool } from '../tools/zod-tool';
import type { ToolContext } from '../agent/tool-dispatch/types';
import { getProfile } from './loader';

const IDENTITY_FILE_NAMES = ['SOUL.md', 'IDENTITY.md', 'AGENTS.md'] as const;

export interface UpdateIdentityConfig {
  profileId: string;
  /** Callback to reload identity files into system prompt */
  onReload: () => void;
}

export class UpdateIdentityTool extends ZodTool {
  readonly = false;
  name = 'update_identity';
  description =
    'Update your own identity files (SOUL.md, IDENTITY.md, AGENTS.md) in your profile. ' +
    'Use when the user helps you define or refine your role, personality, skills, or working style. ' +
    'After writing, your system prompt is automatically reloaded so changes take effect immediately.';

  schema = z.object({
    file: z.enum(IDENTITY_FILE_NAMES).describe('Which identity file to update'),
    content: z.string().describe('Full new content for the file (Markdown). Overwrites existing content.'),
  });

  conflictKey = () => 'update_identity:global';

  private config: UpdateIdentityConfig;

  constructor(config: UpdateIdentityConfig) {
    super();
    this.config = config;
  }

  protected handle(
    args: z.infer<typeof this.schema>,
    _ctx: ToolContext,
  ): { file: string; path: string; reloaded: boolean } {
    const profile = getProfile(this.config.profileId);
    const filePath = join(profile.dataDir, args.file);

    writeFileSync(filePath, args.content, 'utf-8');

    // Reload identity into current system prompt
    this.config.onReload();

    return { file: args.file, path: filePath, reloaded: true };
  }
}
