import { ZodTool } from '../tools/zod-tool';
import type { ToolContext } from '../agent/tool-dispatch/types';
import { z } from 'zod';
import type { MemoryStore, MemoryRetriever } from './types';

const DEFAULT_LIST_LIMIT = 10;

export class MemoryTool extends ZodTool<z.ZodObject<{
  command: z.ZodEnum<['search', 'add', 'list', 'forget']>;
  query: z.ZodOptional<z.ZodString>;
  text: z.ZodOptional<z.ZodString>;
  id: z.ZodOptional<z.ZodString>;
  limit: z.ZodOptional<z.ZodNumber>;
}>> {
  protected readonly name = 'memory';
  protected readonly description = `Read, write, or search persistent memory across conversations. Use to remember user preferences, project facts, and important decisions.

Commands:
- search: Find relevant memories for a query
- add: Store a new reusable memory
- list: List recent memories
- forget: Remove a specific memory by ID

Only store genuinely reusable information that will be useful in future conversations.`;

  readonly = false;
  conflictKey = () => 'memory:global';

  protected schema = z.object({
    command: z.enum(['search', 'add', 'list', 'forget']),
    query: z.string().optional(),
    text: z.string().optional(),
    id: z.string().optional(),
    limit: z.number().optional(),
  });

  constructor(
    private store: MemoryStore,
    private retriever: MemoryRetriever,
  ) {
    super();
  }

  protected async handle(params: z.infer<typeof this.schema>, _ctx: ToolContext): Promise<unknown> {
    switch (params.command) {
      case 'search': {
        if (!params.query) throw new Error('query parameter is required for search');
        const results = await this.retriever.search(params.query, {
          limit: params.limit || DEFAULT_LIST_LIMIT,
        });
        return { results };
      }

      case 'add': {
        if (!params.text) throw new Error('text parameter is required for add');
        const entry = await this.store.add({
          type: 'general',
          text: params.text,
          weight: 0.8,
          source: 'user',
        });
        return { entry };
      }

      case 'list': {
        const limit = params.limit || DEFAULT_LIST_LIMIT;
        const results = await this.store.getRecent(limit);
        return { results };
      }

      case 'forget': {
        if (!params.id) throw new Error('id parameter is required for forget');
        const removed = await this.store.remove(params.id);
        return { removed };
      }

      default:
        throw new Error(`Unknown command: ${params.command}`);
    }
  }
}
