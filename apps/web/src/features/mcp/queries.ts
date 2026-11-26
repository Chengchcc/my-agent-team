import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { mcpKeys } from "./query-keys";
import { shapeToolCatalog, type ToolCatalog } from "./tool-catalog";

export interface McpCatalogRow {
  serverId: string;
  name: string;
  transport: "stdio" | "sse";
  command: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
  headers?: Record<string, string> | null;
  url: string | null;
  /** The connection manager's state in this backend process: connected | pending | failed.
   *  Absent until something tried to connect. */
  status?: string;
  toolsCount?: number;
  runtimeStatus?: "mounted" | "failed";
  runtimeToolsCount?: number;
  runtimeError?: string;
  runtimeRunId?: string;
  runtimeCheckedAt?: number;
}

/** The stored settings of one server. Secrets arrive masked; the form treats them as write-only. */
export type McpServerDetail = Omit<McpCatalogRow, "status" | "toolsCount" | "runtimeStatus">;

export function mcpCatalogQuery() {
  return queryOptions({
    queryKey: mcpKeys.all,
    queryFn: () => api.listMcpServers() as Promise<{ mcpServers: McpCatalogRow[] }>,
  });
}

export function mcpServerQuery(serverId: string) {
  return queryOptions({
    queryKey: mcpKeys.server(serverId),
    queryFn: async (): Promise<McpServerDetail | null> => {
      const response: { mcpServer?: McpServerDetail } = await api.getMcpServer(serverId);
      return response.mcpServer ?? null;
    },
  });
}

/** The tool catalog of one server. Fetching it connects to the server, so it is never fetched by
 *  a page load: the detail's "Discover tools" button calls `refetch`, and the answer stays. */
export function mcpToolCatalogQuery(serverId: string) {
  return queryOptions({
    queryKey: mcpKeys.tools(serverId),
    queryFn: async (): Promise<ToolCatalog> => {
      const raw = await api.getMcpToolCatalog(serverId);
      const catalog = shapeToolCatalog(raw);
      return catalog;
    },
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
