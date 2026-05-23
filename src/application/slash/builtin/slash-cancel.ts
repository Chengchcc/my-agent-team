import type { SlashCommand } from '../slash-types';

export const slashCancelCommand: SlashCommand = {
  name: 'cancel',
  description: 'Cancel the in-flight agent turn for the current session',
  source: 'builtin',
  group: 'context',
  async resolve(_input, ctx) {
    if (!ctx.sessionId) {
      return { kind: 'handled' as const, message: 'No active session.' };
    }
    try {
      await ctx.kernel.rpc('input.cancel', {
        sessionId: ctx.sessionId,
        reason: 'user-cancel',
      });
      return { kind: 'handled' as const, message: '_\u5DF2\u8BF7\u6C42\u53D6\u6D88\u5F53\u524D\u56DE\u5408\u3002_' };
    } catch (err) {
      return {
        kind: 'handled' as const,
        message: `Cancel failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
