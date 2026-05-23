/** Summary of server capabilities for contract use (no ext-internal imports). */
export interface McpCapabilitiesSummary {
  tools: number;
  resources: number;
  prompts: number;
}

export interface McpServerConnectedV1 {
  name: string;
  capabilities: McpCapabilitiesSummary;
}

export interface McpServerDisconnectedV1 {
  name: string;
  reason: 'shutdown' | 'error' | 'removed';
}

export interface McpServerFailedV1 {
  name: string;
  message: string;
  attempt: number;
}

export interface McpReloadedV1 {
  reconnected: string[];
  failed: string[];
}

export interface McpToolsChangedV1 {
  added: string[];
  removed: string[];
  serverName: string;
}
