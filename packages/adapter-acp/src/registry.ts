/** ACP agent registry (ADR 0039 decision 4): one client drives every
 *  ACP-compatible agent; an entry says how to launch its server.
 *
 *  The shape mirrors acpx's AGENT_DEFINITIONS on purpose (name → argv +
 *  requiredCommands + npm-pinned bridge), so any agent acpx knows is a
 *  one-line addition here. Wire stays v1; extensions follow the v2
 *  extensibility shapes (underscore methods, `_meta`) — see ADR 0039. */

export interface AcpAgentEntry {
  /** Human-readable label for catalogs and logs. */
  readonly name: string;
  /** Launch argv for the agent's ACP server (stdio JSON-RPC). */
  readonly argv: readonly string[];
  /** Binaries that must exist on PATH for this entry to be usable. */
  readonly requiredCommands?: readonly string[];
}

export const ACP_AGENTS: Readonly<Record<string, AcpAgentEntry>> = {
  omp: {
    name: "omp (native ACP)",
    argv: ["omp", "acp", "--approval-mode", "always-ask"],
    requiredCommands: ["omp"],
  },
  claude: {
    name: "Claude Code (official bridge)",
    argv: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@^0.76.0"],
    requiredCommands: ["claude"],
  },
  pi: {
    name: "pi (pi-acp bridge)",
    argv: ["npx", "-y", "pi-acp@^0.0.33"],
    requiredCommands: ["pi"],
  },
};

export const DEFAULT_ACP_AGENT = "omp";

/** Resolve a registry entry by the run's model id (the agent key, e.g.
 *  "omp"). The LLM behind it stays the agent's own configuration — the acp
 *  kind's model catalog lists registry keys, not provider models. */
export function resolveAcpAgent(id: string | undefined): AcpAgentEntry {
  // Accept both the bare registry key and the catalog-joined "acp/<key>"
  // (BackendModelRef.modelId carries whatever the agent record stored).
  const bare = id?.startsWith("acp/") ? id.slice(4) : id;
  const key = bare && bare in ACP_AGENTS ? bare : DEFAULT_ACP_AGENT;
  return ACP_AGENTS[key]!;
}
