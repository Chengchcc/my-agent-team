import { useMutation, useQueryClient } from "@tanstack/react-query";
import { agentKeys } from "@/features/agents/query-keys";
import { api } from "@/lib/api";
import type { McpServerDetail } from "./queries";
import { mcpKeys } from "./query-keys";
import { shapeToolCall, type ToolCallOutcome } from "./tool-catalog";

/** What `POST /mcp-servers/:id/test` answers, shown as returned. */
export interface ConnectionTest {
  status: string;
  toolsCount: number;
}

/** The settings a person may save. Secrets (`env`, `headers`) are whole maps: sending one
 *  replaces every stored value of it, and leaving it out keeps what is stored. */
export interface ServerSettings {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  url?: string;
}

/** A new connection always says how it is reached. */
export interface NewServerSettings extends ServerSettings {
  transport: "stdio" | "sse";
}

/** The create and update routes answer a validation error with a 4xx status and an error body.
 *  The shared client hands any JSON back as if it were a server, so the status is read here. */
function serverOf(response: unknown, fallback: string): McpServerDetail {
  if (typeof response !== "object" || response === null) throw new Error(fallback);
  const candidate = response as { mcpServer?: McpServerDetail; error?: string };
  if (candidate.error !== undefined) throw new Error(candidate.error);
  if (candidate.mcpServer === undefined) throw new Error(fallback);
  return candidate.mcpServer;
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method: "POST", credentials: "include" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) {
    const reason = data === null ? "" : data.error;
    throw new Error(reason === "" ? `HTTP ${response.status}` : reason);
  }
  return data as T;
}

export function useCreateMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (settings: NewServerSettings): Promise<McpServerDetail> => {
      const response = await api.createMcpServer(settings);
      const server = serverOf(response, "The server was not added");
      return server;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: mcpKeys.all });
    },
  });
}

export function useUpdateMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      serverId: string;
      settings: ServerSettings;
    }): Promise<McpServerDetail> => {
      const response = await api.updateMcpServer(input.serverId, input.settings);
      const server = serverOf(response, "The server was not saved");
      return server;
    },
    onSuccess: (_server, input) => {
      // The stored settings changed, so a catalog discovered before no longer describes them.
      qc.removeQueries({ queryKey: mcpKeys.tools(input.serverId) });
      void qc.invalidateQueries({ queryKey: mcpKeys.all });
    },
  });
}

export function useDeleteMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (serverId: string): Promise<void> => {
      const removed = await api.deleteMcpServer(serverId);
      if (!removed) throw new Error("The server was not deleted");
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: mcpKeys.all });
    },
  });
}

/** An explicit probe: it reconnects and reports what the connection manager saw. */
export function useTestMcpConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (serverId: string): Promise<ConnectionTest> =>
      post<ConnectionTest>(`/api/bff/mcp-servers/${serverId}/test`),
    onSuccess: () => {
      // The probe changed the manager's state, which the catalog's status field reflects.
      void qc.invalidateQueries({ queryKey: mcpKeys.all });
    },
  });
}

/** Disconnect and connect again from the stored settings. */
export function useRestartMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (serverId: string): Promise<{ status: string }> =>
      post<{ status: string }>(`/api/bff/mcp-servers/${serverId}/restart`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: mcpKeys.all });
    },
  });
}

/** Calls one tool for real. It runs with the login only: no approval, no audit entry. */
export function useInvokeMcpTool() {
  return useMutation({
    mutationFn: async (input: {
      serverId: string;
      tool: string;
      args: Record<string, unknown>;
    }): Promise<ToolCallOutcome> => {
      const raw = await post<{ result?: unknown }>(
        `/api/bff/mcp-servers/${input.serverId}/tools/invoke`,
        { tool: input.tool, args: input.args },
      );
      const outcome = shapeToolCall(raw);
      return outcome;
    },
  });
}

/** Rewrites one member's binding list for a connection. The list is the member's whole
 *  `mcpServers`, other servers carried over; see `bindChanges`. */
export function useSetAgentMcpServers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      agentId: string;
      mcpServers: Array<{ serverId: string; enabled: boolean }>;
    }) => api.updateAgent(input.agentId, { mcpServers: input.mcpServers }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentKeys.lists() });
    },
  });
}
