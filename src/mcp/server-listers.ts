import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpToolDef, McpResourceDef, McpPromptDef, McpPromptArgument } from './types';
import { debugLog } from '../utils/debug';

export async function listServerTools(client: Client): Promise<McpToolDef[]> {
  const result = await client.listTools();
  const mapped: McpToolDef[] = [];
  for (const t of result.tools || []) {
    const def: McpToolDef = {
      name: t.name,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    };
    if (t.description !== undefined) {
      def.description = t.description;
    }
    mapped.push(def);
  }
  return mapped;
}

export async function listServerResources(client: Client): Promise<McpResourceDef[]> {
  try {
    const result = await client.listResources();
    const mapped: McpResourceDef[] = [];
    for (const r of result.resources || []) {
      const def: McpResourceDef = {
        uri: r.uri,
        name: r.name,
      };
      if (r.description !== undefined) {
        def.description = r.description;
      }
      if (r.mimeType !== undefined) {
        def.mimeType = r.mimeType;
      }
      mapped.push(def);
    }
    return mapped;
  } catch (err) {
    debugLog(`[McpManager] _listResources failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export async function listServerPrompts(client: Client): Promise<McpPromptDef[]> {
  try {
    const result = await client.listPrompts();
    const mapped: McpPromptDef[] = [];
    for (const p of result.prompts || []) {
      const def: McpPromptDef = {
        name: p.name,
      };
      if (p.description !== undefined) {
        def.description = p.description;
      }
      if (p.arguments !== undefined) {
        const args: McpPromptArgument[] = [];
        for (const a of p.arguments) {
          const arg: McpPromptArgument = { name: a.name };
          if (a.description !== undefined) arg.description = a.description;
          if (a.required !== undefined) arg.required = a.required;
          args.push(arg);
        }
        def.arguments = args;
      }
      mapped.push(def);
    }
    return mapped;
  } catch (err) {
    debugLog(`[McpManager] _listPrompts failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
