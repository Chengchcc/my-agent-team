import type { McpServerConfig } from '../../config/types';


export interface McpToolDef {
  name: string;
  description?: string;
  /** JSON Schema for tool input */
  parameters: Record<string, unknown>;
}

export interface McpResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptDef {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptResult {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface McpCapabilities {
  tools: McpToolDef[];
  resources: McpResourceDef[];
  prompts: McpPromptDef[];
}

export type McpConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; capabilities: McpCapabilities; startedAt: number }
  | { status: 'error'; message: string; since: number }
  | { status: 'exhausted'; message: string; since: number };

/** Internal per-server entry held by McpManager */
export interface McpClientEntry {
  config: McpServerConfig;
  client: unknown;    // @modelcontextprotocol/sdk Client — cast at usage site
  transport: unknown; // Transport instance — cast at usage site
  state: McpConnectionState;
}
