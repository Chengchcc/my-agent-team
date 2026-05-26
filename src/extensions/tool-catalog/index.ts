import { defineExtension } from '../../kernel/define-extension';
import type { HookHandler } from '../../kernel/define-extension';
import { InMemoryCatalog } from '../../application/tool-catalog/in-memory-catalog';
import { InProcessExecutor } from '../../infrastructure/tool/in-process-executor';
import { dispatchTool } from '../../application/usecases/dispatch-tool';
import type { ToolCatalog } from '../../application/ports/tool-catalog';
import type { ToolExecutor } from '../../application/ports/tool-executor';
import type { ToolContext } from '../../application/ports/tool-context';
import { createEvent } from '../../application/contracts';
import { asContractBus } from '../../application/event-bus/contract-bus';

export default () =>
  defineExtension({
    name: 'tool-catalog',
    enforce: 'pre',

    apply: (ctx) => {
      const catalog: ToolCatalog = new InMemoryCatalog();
      const executor: ToolExecutor = new InProcessExecutor();
      const contractBus = asContractBus(ctx.bus);

      const onToolCall: HookHandler = async (...args: unknown[]) => {
        const call = args[0] as { name: string; arguments: Record<string, unknown>; id: string };
        const toolCtx = args[1] as ToolContext;

        const startTime = Date.now();
        const result = await dispatchTool(catalog, executor, call, toolCtx);
        const duration = Date.now() - startTime;

        const isError = typeof result === 'object' && result !== null && 'isError' in result
          ? (result as { isError?: boolean }).isError === true
          : false;

        await contractBus.emit(createEvent('tool.executed', {
          name: call.name,
          duration,
          isError,
        }));

        return result;
      };

      const resolveTools: HookHandler = async (...args: unknown[]) => {
        const existing = args[0] as Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
        const existingNames = new Set(existing.map((t) => t.name));
        const catalogTools = catalog.list()
          .filter((t) => !existingNames.has(t.name))
          .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
        return [...existing, ...catalogTools];
      };

      return {
        provide: {
          'tool-catalog.catalog': () => catalog,
        },
        hooks: {
          resolveTools: {
            enforce: 'normal',
            fn: resolveTools,
          },
          onToolCall: {
            enforce: 'normal',
            fn: onToolCall,
          },
        },
        dispose: () => {},
      };
    },
  });
