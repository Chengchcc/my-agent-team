import { type ConnectionState, connectionState, type ToolCatalog } from "./tool-catalog";

/** What a card states about one connection. The old page folded it all into one "Reachable"
 *  pill: a saved server can have a catalog and no connection, or the other way round. */
export interface McpFacts {
  /** The tool list exists only after an explicit discovery (the backend's memory). */
  catalog: { discovered: boolean; count: number };
  /** What the connection manager saw: the backend's own probe. */
  connection: ConnectionState;
  /** The latest agent run's mount result: a different observer from `connection`. */
  runtime: {
    status: "mounted" | "failed";
    toolsCount: number;
    checkedAt: number | null;
  } | null;
  /** How many env and header values are stored. Their content never reaches the page. */
  secrets: { env: number; headers: number };
}

/** What the facts read. Secret values are not part of it. */
export interface FactsSource {
  status?: string;
  runtimeStatus?: "mounted" | "failed";
  runtimeToolsCount?: number;
  runtimeCheckedAt?: number;
  env?: Record<string, unknown> | null;
  headers?: Record<string, unknown> | null;
}

export function mcpFacts(row: FactsSource, catalog: ToolCatalog | undefined): McpFacts {
  const source = catalog === undefined ? row.status : catalog.status;
  let runtime: McpFacts["runtime"] = null;
  if (row.runtimeStatus !== undefined) {
    runtime = {
      status: row.runtimeStatus,
      toolsCount: row.runtimeToolsCount ?? 0,
      checkedAt: row.runtimeCheckedAt ?? null,
    };
  }
  return {
    catalog: {
      discovered: catalog !== undefined,
      count: catalog === undefined ? 0 : catalog.tools.length,
    },
    connection: connectionState(source),
    runtime,
    secrets: {
      env: Object.keys(row.env ?? {}).length,
      headers: Object.keys(row.headers ?? {}).length,
    },
  };
}
