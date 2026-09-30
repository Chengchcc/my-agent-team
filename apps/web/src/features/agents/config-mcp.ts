"use client";

import { normalizeReasoningEffort } from "@chengchenccc/agent-contract";
import { useEffect, useRef } from "react";
import type { AgentDraft } from "@/components/agent-form-types";
import type { AgentRow } from "@/lib/api";
import { api } from "@/lib/api";

// Must stay in sync with AgentRow["permissionMode"] (backend permission_mode).
const PERMISSION_MODES = ["ask", "auto", "deny"] as const;
/** Map an agent.yml-shaped config (what the agent-config MCP agent_write
 *  proposes / the backend PATCH emits) to the AgentRow shape that AgentForm's
 *  form.reset() consumes. The proposed config doesn't carry workspacePath or
 *  lark credential/status — those ride the base agent the form was opened on. */
export function agentConfigToRow(config: unknown, base: AgentRow): AgentRow {
  const c = (config ?? {}) as Record<string, unknown>;
  const rc = (c.runtime_config ?? {}) as Record<string, unknown>;
  const lk = (c.lark ?? {}) as Record<string, unknown>;
  const mcpServers = Array.isArray(rc.mcp_servers)
    ? (rc.mcp_servers as Array<{ server_id: string; enabled: boolean }>).map((s) => ({
        serverId: s.server_id,
        enabled: s.enabled,
      }))
    : [];
  const maxSteps = typeof rc.max_steps === "number" && rc.max_steps > 0 ? rc.max_steps : null;

  return {
    ...base,
    name: String(c.name ?? base.name),
    enabled: Boolean(c.enabled ?? base.enabled),
    // The harness key is the identity; the model is an opaque id in that
    // harness's own vocabulary ("" = its own default).
    harness: String(rc.harness ?? base.harness),
    model: String(rc.model ?? base.model),
    reasoningEffort: normalizeReasoningEffort(rc.reasoning_effort) ?? null,
    permissionMode: PERMISSION_MODES.find((m) => m === rc.permission_mode) ?? base.permissionMode,
    maxSteps,
    mcpServers,
    knowledgePacks: Array.isArray(rc.knowledge_packs) ? (rc.knowledge_packs as string[]) : [],
    projects: Array.isArray(rc.projects) ? (rc.projects as string[]) : [],
    lark: {
      ...base.lark,
      enabled: Boolean(lk.enabled ?? base.lark?.enabled),
      botDisplayName: String(lk.bot_display_name ?? base.lark?.botDisplayName ?? ""),
    },
  };
}

/** Map a chat-proposed config to the create page's draft (see AgentDraft for
 *  what is deliberately dropped). */
export function agentConfigToDraft(config: unknown): AgentDraft {
  const c = (config ?? {}) as Record<string, unknown>;
  const rc = (c.runtime_config ?? {}) as Record<string, unknown>;
  const maxSteps = typeof rc.max_steps === "number" && rc.max_steps > 0 ? rc.max_steps : null;
  const effort = normalizeReasoningEffort(rc.reasoning_effort);
  const permissionMode = PERMISSION_MODES.find((m) => m === rc.permission_mode);
  const name = typeof c.name === "string" && c.name.trim() !== "" ? c.name : undefined;
  const harness = typeof rc.harness === "string" && rc.harness !== "" ? rc.harness : undefined;
  const model = typeof rc.model === "string" ? rc.model : "";
  return {
    ...(name ? { name } : {}),
    ...(harness ? { harness } : {}),
    model,
    ...(effort ? { reasoningEffort: effort } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    maxSteps,
    mcpServers: Array.isArray(rc.mcp_servers)
      ? rc.mcp_servers.map((s) => {
          const row = (s ?? {}) as { server_id?: unknown; enabled?: unknown };
          return { serverId: String(row.server_id ?? ""), enabled: Boolean(row.enabled) };
        })
      : [],
    knowledgePacks: Array.isArray(rc.knowledge_packs) ? (rc.knowledge_packs as string[]) : [],
  };
}

/** Subscribe to an agent's config SSE. `onProposed` fires when the chat
 *  agent proposes a new config (trigger="mcp"); `onSaved` when the config is
 *  saved via HTTP PATCH (trigger="save"). Resubscribes only when agentId or a
 *  callback identity changes. */
export function useAgentConfigEvents(
  agentId: string | undefined,
  handlers: { onProposed: (config: unknown) => void; onSaved?: (config: unknown) => void },
) {
  // Keep the latest handlers in a ref so the effect (keyed only on agentId)
  // never resubscribes per render yet always calls the current callbacks.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  // A proposed change is a durable row (ADR 0040), so the page reads it instead of listening: a
  // proposal that arrived while this page was closed is still adoptable, and adopting marks the
  // row - a second reader gets a 409 that is not an error. The per-target SSE that used to carry
  // it is gone.
  useEffect(() => {
    if (!agentId) return;
    let stopped = false;
    let adopted = "";
    const tick = async () => {
      const result = await api.getPendingProposal("agent_config", agentId).catch(() => null);
      const proposal = result?.proposal;
      if (stopped || !proposal || proposal.id === adopted) return;
      adopted = proposal.id;
      handlersRef.current.onProposed(proposal.payload);
      await api.resolveProposal(proposal.id, "adopted").catch(() => {
        /* a page that got there first is not a failure */
      });
    };
    const timer = setInterval(tick, 2000);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [agentId]);
}
