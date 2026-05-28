import path from 'node:path'
import { defineExtension } from '../../kernel/define-extension';
import type { HookHandler } from '../../kernel/define-extension';
import { defineTool } from '../../application/tool-factory/define-tool';
import type { ToolCatalog } from '../../application/ports/tool-catalog';
import { createBashExecute } from './bash';
import { truncateOutput } from './truncation';
import { bashToolSchema } from '../../application/contracts/tool-schemas/bash';
import { readToolSchema } from '../../application/contracts/tool-schemas/read';
import { readExecute } from './read';
import { textEditorToolSchema } from '../../application/contracts/tool-schemas/text-editor';
import { createTextEditorExecute } from './text-editor';
import { grepToolSchema } from '../../application/contracts/tool-schemas/grep';
import { grepExecute } from './grep';
import { globToolSchema } from '../../application/contracts/tool-schemas/glob';
import { globExecute } from './glob';
import { lsToolSchema } from '../../application/contracts/tool-schemas/ls';
import { lsExecute } from './ls';
import { webSearchToolSchema } from '../../application/contracts/tool-schemas/web-search';
import { webSearchExecute } from './web-search';
import { webFetchToolSchema } from '../../application/contracts/tool-schemas/web-fetch';
import { webFetchExecute } from './web-fetch';
import { askUserQuestionToolSchema } from '../../application/contracts/tool-schemas/ask-user-question';
import { askUserQuestionExecute } from './ask-user-question';
import { todoWriteToolSchema } from '../../application/contracts/tool-schemas/todo-write';
import { todoWriteExecute } from './todo-write';

const KB = 1024
const CAP_100KB = 100 * KB
// eslint-disable-next-line @typescript-eslint/no-magic-numbers
const CAP_50KB = 50 * KB
// eslint-disable-next-line @typescript-eslint/no-magic-numbers
const CAP_200KB = 200 * KB

/** Register all builtin tools into the given catalog. */
function registerBuiltinTools(catalog: ToolCatalog): void {
  // helper: wrap execute with outputCap truncation for string results
  const cap = (fn: (...args: unknown[]) => unknown, capBytes: number) =>
    async (...args: unknown[]): Promise<unknown> => {
      const result = await fn(...args)
      return typeof result === 'string' ? truncateOutput(result, capBytes) : result
    }

  catalog.register(defineTool({
    name: 'bash',
    description: 'Execute a shell command on the local system.',
    parameters: bashToolSchema.jsonSchema,
    parse: bashToolSchema.parse,
    execute: cap((tCtx: unknown, params: unknown) => createBashExecute()(params as never, tCtx as never), CAP_100KB),
    conflictKey: (_toolCtx) => 'bash:global',
    outputCap: CAP_100KB,
  }))

  catalog.register(defineTool({
    name: 'read',
    description: 'Read file content with optional line range support.',
    parameters: readToolSchema.jsonSchema,
    parse: readToolSchema.parse,
    execute: cap((tCtx: unknown, params: unknown) => readExecute(params as never, tCtx as never), CAP_100KB),
    readonly: true,
    outputCap: CAP_100KB,
  }))

  catalog.register(defineTool({
    name: 'text_editor',
    description: 'Read, create, edit, and write text files.',
    parameters: textEditorToolSchema.jsonSchema,
    parse: textEditorToolSchema.parse,
    execute: cap((tCtx: unknown, params: unknown) => createTextEditorExecute()(params as never, tCtx as never), CAP_100KB),
    conflictKey: (_toolCtx, input: unknown) => {
      const raw = (input as Record<string, unknown>).path
      const resolved = typeof raw === 'string' ? path.resolve(raw) : 'unknown'
      return `file:${resolved}`
    },
    outputCap: CAP_100KB,
  }))

  catalog.register(defineTool({
    name: 'grep',
    description: 'Search for text patterns in files using regex.',
    parameters: grepToolSchema.jsonSchema,
    parse: grepToolSchema.parse,
    execute: cap((tCtx: unknown, params: unknown) => grepExecute(params as never, tCtx as never), CAP_50KB),
    readonly: true,
    outputCap: CAP_50KB,
  }))

  catalog.register(defineTool({
    name: 'glob',
    description: 'Find files matching a glob pattern.',
    parameters: globToolSchema.jsonSchema,
    parse: globToolSchema.parse,
    execute: cap((tCtx: unknown, params: unknown) => globExecute(params as never, tCtx as never), CAP_50KB),
    readonly: true,
    outputCap: CAP_50KB,
  }))

  catalog.register(defineTool({
    name: 'ls',
    description: 'List the contents of a directory.',
    parameters: lsToolSchema.jsonSchema,
    parse: lsToolSchema.parse,
    execute: cap((tCtx: unknown, params: unknown) => lsExecute(params as never, tCtx as never), CAP_50KB),
    readonly: true,
    outputCap: CAP_50KB,
  }))

  catalog.register(defineTool({
    name: 'web_search',
    description: 'Search the web for current information.',
    parameters: webSearchToolSchema.jsonSchema,
    parse: webSearchToolSchema.parse,
    execute: cap((tCtx: unknown, params: unknown) => webSearchExecute(params as never, tCtx as never), CAP_50KB),
    readonly: true,
    outputCap: CAP_50KB,
  }))

  catalog.register(defineTool({
    name: 'web_fetch',
    description: 'Fetch and process content from a URL.',
    parameters: webFetchToolSchema.jsonSchema,
    parse: webFetchToolSchema.parse,
    execute: cap((tCtx: unknown, params: unknown) => webFetchExecute(params as never, tCtx as never), CAP_200KB),
    readonly: true,
    outputCap: CAP_200KB,
  }))
}

export default () =>
  defineExtension({
    name: 'tools',
    enforce: 'normal',
    dependsOn: ['tool-catalog'],

    apply: (ctx) => {
      const catalog = ctx.extensions.get('tool-catalog.catalog')
      registerBuiltinTools(catalog)

      catalog.register(defineTool({
        name: 'ask_user_question',
        description: 'Ask the user questions to gather preferences or clarify requirements.',
        parameters: askUserQuestionToolSchema.jsonSchema,
        parse: askUserQuestionToolSchema.parse,
        execute: async (toolCtx, params) => askUserQuestionExecute(params as never, toolCtx),
        conflictKey: (_toolCtx) => 'ask:global',
      }));

      catalog.register(defineTool({
        name: 'todo_write',
        description: 'Track a multi-step plan visible to the user. Use SPARINGLY.',
        parameters: todoWriteToolSchema.jsonSchema,
        parse: todoWriteToolSchema.parse,
        execute: async (toolCtx, params) => todoWriteExecute(params as never, toolCtx),
        conflictKey: (_toolCtx) => 'todo:global',
      }));

      const resolveTools: HookHandler = async (...args: unknown[]) => {
        const existing = args[0] as Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
        const existingNames = new Set(existing.map((t) => t.name));
        const catalogTools = catalog.list()
          .filter((t) => !existingNames.has(t.name))
          .map((t) => ({
            name: t.name, description: t.description, parameters: t.parameters,
            readonly: t.readonly, conflictKey: t.conflictKey,
          }));
        return [...existing, ...catalogTools];
      };

      const transformPrompt: HookHandler = async (...args: unknown[]) => {
        const input = args[0] as { system: string; messages: Array<{ role: string; content: string }> }
        // Bootstrap mode short-circuit — do not pollute system with tool guidance
        try {
          const registry = ctx.extensions.get('agent.registry') as { current(): Promise<{ identityStatus: string }> } | undefined
          const rec = await registry?.current().catch(() => null)
          if (rec?.identityStatus === 'pending_bootstrap') return input
        } catch { /* fall through */ }
        const hasTodoWrite = catalog.list().some(t => t.name === 'todo_write')
        if (!hasTodoWrite) return input
        return { ...input, system: `${input.system}\n\n${TODO_WRITE_GUIDANCE}` }
      }

      return {
        hooks: {
          resolveTools: {
            enforce: 'normal',
            fn: resolveTools,
          },
          transformPrompt: {
            enforce: 'normal',
            fn: transformPrompt,
          },
        },
        dispose: () => {},
      };
    },
  });

const TODO_WRITE_GUIDANCE = `## Task Tracking

You have access to a \`todo_write\` tool. Use it SPARINGLY — only when ALL of:
  1. The task has 3+ distinct, non-trivial steps.
  2. The work spans multiple turns or takes >1 minute wall time.
  3. The user benefits from visible progress.

DO NOT use for: single-tool answers, quick lookups, conversational replies.

When you do use it:
- Exactly one item \`in_progress\` at a time.
- Mark items \`completed\` in the same turn they finish.
- Send the FULL list each call (replace semantics, not delta).
- Don't keep re-asserting an empty list — the widget self-hides when empty.`
