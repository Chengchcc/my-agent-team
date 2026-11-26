import { useQuery } from "@tanstack/react-query";
import { mcpCatalogQuery, mcpServerQuery, mcpToolCatalogQuery } from "./queries";

export function useMcpCatalog() {
  return useQuery(mcpCatalogQuery());
}

export function useMcpServer(serverId: string) {
  return useQuery({ ...mcpServerQuery(serverId), enabled: serverId !== "" });
}

/** The last discovered catalog of one server. Empty until "Discover tools" calls `refetch`;
 *  fetching connects to the server, so it never runs on mount. */
export function useMcpToolCatalog(serverId: string) {
  const options = mcpToolCatalogQuery(serverId);
  return useQuery(options);
}

export type { ConnectionTest, NewServerSettings, ServerSettings } from "./mutations";
export {
  useCreateMcpServer,
  useDeleteMcpServer,
  useInvokeMcpTool,
  useRestartMcpServer,
  useSetAgentMcpServers,
  useTestMcpConnection,
  useUpdateMcpServer,
} from "./mutations";
export { mcpKeys } from "./query-keys";
