import type { SlashCommand, SlashResolution, SlashContext } from '../slash-types';

export const slashPermissions: SlashCommand = {
  name: 'permissions',
  description: 'View and manage always-allowed tools. /permissions remove <tool> to revoke.',
  source: 'builtin',
  group: 'core',
  async resolve(input: string, ctx: SlashContext): Promise<SlashResolution> {
    const args = input.trim().split(/\s+/);
    if (args[1] === 'remove' && args[2]) {
      const toolName = args[2]!;
      const result = await ctx.kernel.rpc('permission.remove', { sessionId: ctx.sessionId, toolName });
      const ok = (result as { ok?: boolean })?.ok;
      return { kind: 'handled', message: ok ? `Removed "${toolName}" from always-allow list.` : `Tool "${toolName}" not found.` };
    }

    const result = await ctx.kernel.rpc('permission.list', { sessionId: ctx.sessionId });
    const tools = (result as { tools?: string[] })?.tools ?? [];
    if (tools.length === 0) {
      return { kind: 'handled', message: 'No tools have always-allow permission.\n\nUse `[Y] always` in permission prompts to add tools. Then use `/permissions remove <tool>` to revoke.' };
    }
    const lines = [
      '**Always-allowed tools**',
      '',
      ...tools.map(t => `  - ${t}`),
      '',
      'To remove: `/permissions remove <toolName>`',
    ];
    return { kind: 'handled', message: lines.join('\n') };
  },
};
