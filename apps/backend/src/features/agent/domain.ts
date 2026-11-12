import {
  type BackendModelRef,
  normalizeReasoningEffort,
} from "../../features/agent-run/protocol/index.js";
import type { AgentConfig } from "./agent-config.js";

/** Agent row (file-first, ADR 0020 decision 1): the DB keeps only the FK
 *  anchor (id), the workspace location, and a materialized cache of the
 *  parsed `agent.yml` (`config`). */
export interface AgentRow {
  id: string;
  workspacePath: string;
  config: AgentConfig;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface AmbientRuleInput {
  id: string;
  chats?: string[];
  senders?: string[];
  keyword: string;
  /** ADR 0047: promotion target agent; absent = the conversation's own. */
  agent?: string;
  mode: "record" | "act";
  instruction?: string;
}

export interface CreateAgentInput {
  /** Optional explicit id; used by the bootstrap seed to create a stable "default" agent.
   *  Not accepted from HTTP clients — the POST /api/agents body schema omits this field. */
  id?: string;
  name: string;
  template?: string;
  /** ADR 0048 capability card: free-text role description. */
  description?: string;
  /** ADR 0048 capability card entries; replace-semantics. */
  skills?: Array<{ id: string; description?: string }>;
  /** ADR 0049 role; "worker" opts into the front desk invariant. */
  role?: "front" | "worker";
  /** Which harness runs this agent (an ACP_AGENTS key). */
  harness: string;
  /** The model that harness runs; "" or omitted = its own default. */
  model?: string;
  /** Top-level kill switch (agent.yml enabled). Defaults to true. */
  enabled?: boolean;
  /** Optional workspace override (agent-hub 预留): an absolute path the
   *  oma runs in (its AGENTS.md/CLAUDE.md take effect there).
   *  Defaults to the managed <dataDir>/agents/<id>. */
  workspacePath?: string;
  reasoningEffort?: "none" | "low" | "high" | "max" | null;
  permissionMode?: "ask" | "auto" | "deny" | "yolo";
  /** Write-path policy injected into the child (allow-rules, first slice).
   *  Never read from the workspace: the agent could lift its own rules. */
  denyWritePaths?: string[];
  /** Exact whole-string commands the bash tool refuses (a tripwire). */
  denyCommands?: string[];
  allowWritePaths?: string[];
  mcpServers?: Array<{ serverId: string; enabled: boolean }>;
  knowledgePacks?: string[];
  lark?: {
    enabled: boolean;
    appId?: string;
    appSecret?: string;
    botDisplayName?: string;
    /** DM allowlist (open_id); `"*"` is the explicit wildcard, empty denies. */
    allowedSenders?: string[];
    /** Default policy for groups with no entry in `groups`. */
    groupPolicy?: "open" | "allowlist" | "disabled";
    /** Per-chat overrides keyed by Lark chat id (`oc_…`). */
    groups?: Record<
      string,
      {
        policy?: "open" | "allowlist" | "disabled";
        allowedSenders?: string[];
        requireMention?: boolean;
      }
    >;
    /** Groups require a real @mention. */
    requireMention?: boolean;
    /** Whether an `@everyone` addresses the bot. */
    respondToMentionAll?: boolean;
    /** ADR 0046 ambient rules; replace-semantics like `groups`. */
    ambientRules?: AmbientRuleInput[];
  };
}

export interface UpdateAgentInput {
  name?: string;
  /** ADR 0048 capability card (description + skills), replace-semantics. */
  description?: string;
  skills?: Array<{ id: string; description?: string }>;
  /** ADR 0049 role; "worker" opts into the front desk invariant. */
  role?: "front" | "worker";
  harness?: string;
  model?: string;
  /** Top-level kill switch (agent.yml enabled). */
  enabled?: boolean;
  workspacePath?: string;
  reasoningEffort?: "none" | "low" | "high" | "max" | null;
  permissionMode?: "ask" | "auto" | "deny" | "yolo";
  maxSteps?: number;
  mcpServers?: Array<{ serverId: string; enabled: boolean }>;
  knowledgePacks?: string[];
  projects?: string[];
  lark?: {
    enabled?: boolean;
    appId?: string;
    appSecret?: string;
    botDisplayName?: string;
    /** DM allowlist (open_id); `"*"` is the explicit wildcard, empty denies. */
    allowedSenders?: string[];
    /** Default policy for groups with no entry in `groups`. */
    groupPolicy?: "open" | "allowlist" | "disabled";
    /** Per-chat overrides keyed by Lark chat id (`oc_…`). */
    groups?: Record<
      string,
      {
        policy?: "open" | "allowlist" | "disabled";
        allowedSenders?: string[];
        requireMention?: boolean;
      }
    >;
    /** Groups require a real @mention. */
    requireMention?: boolean;
    /** Whether an `@everyone` addresses the bot. */
    respondToMentionAll?: boolean;
    /** ADR 0046 ambient rules; replace-semantics like `groups`. */
    ambientRules?: AmbientRuleInput[];
    /** profileRef is server-generated — never accepted from clients (§4.5). */
  };
}

/** Canonical Backend model reference for an Agent record. Reads from the
 *  materialized agent.yml config (runtime_config) — the file is the
 *  source (ADR 0020). */
export function agentModelRef(agent: Pick<AgentRow, "config">): BackendModelRef {
  const rc = agent.config.runtime_config;
  // Normalize the stored string against the canonical enum: a row written
  // before the enum existed (or hand-edited in agent.yml) must degrade to
  // "provider default", never fail the child's whole execute payload.
  const reasoningEffort = normalizeReasoningEffort(rc.reasoning_effort);
  // One adapter drives every harness (ADR 0040 decision 7), so the ref's kind is
  // a constant and the harness is the identity. "" as the model means "let the
  // harness decide", which is not the same as naming one.
  return {
    backendKind: "acp",
    modelId: `acp/${rc.harness}`,
    ...(rc.model ? { harnessModel: rc.model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}
