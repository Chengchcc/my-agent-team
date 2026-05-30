import type { SlashCommand, SlashResolution, SlashContext } from '../../application/slash';
import type { ToolCatalog } from '../../application/ports/tool-catalog';
import type { ToolContext } from '../../application/ports/tool-context';

export function createSlashBashCommand(deps: {
  getCatalog: () => ToolCatalog;
}): SlashCommand {
  return {
    name: '!',
    description: 'Execute a shell command directly (bypass LLM). Use `! <command>`.',
    source: 'ext',
    group: 'system',
    visible: false,
    async resolve(input: string, ctx: SlashContext): Promise<SlashResolution> {
      const cmd = input.replace(/^\/!\s*/, '').trim();
      if (!cmd) return { kind: 'handled', message: 'Usage: ! <command>' };

      const catalog = deps.getCatalog();
      const bashTool = catalog.get('bash');
      if (!bashTool) return { kind: 'handled', message: 'Bash tool not available.' };

      try {
        const abort = new AbortController();
        const toolCtx: ToolContext = {
          environment: { cwd: process.cwd() },
          sessionId: ctx.sessionId,
          turnId: `shortcut-${Date.now()}`,
          callId: `shortcut-${Date.now()}`,
          signal: abort.signal,
          sink: {
            updateTodos: () => {},
            emitInlineBlock: () => {},
            emitMemoryHint: () => {},
            log: () => {},
          },
        };
        const result = await bashTool.execute(toolCtx, { command: cmd }) as { result?: string; error?: string };

        if (result.error) {
          return { kind: 'handled', message: `Error: ${result.error}` };
        }
        return {
          kind: 'handled',
          message: result.result ?? '(no output)',
        };
      } catch (e) {
        return { kind: 'handled', message: `Error: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}
