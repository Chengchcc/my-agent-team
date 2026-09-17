"use client";

import { AGENT_DRAFT_ID } from "@chengchenccc/api-contract";
import { useState } from "react";
import { AgentForm } from "@/components/AgentForm";
import { AgentEditorLayout } from "@/components/agent-editor-layout";
import type { AgentDraft } from "@/components/agent-form-types";
import { PageHeader } from "@/components/page";
import { ChatPanel } from "@/components/workflow/ChatPanel";
import { agentConfigToDraft, useAgentConfigEvents } from "@/features/agents/config-mcp";

/** Create-agent page: a persistent create form on the left and a chat on the
 *  right. The chat runs a REAL agent, whose agent-config MCP tools let it
 *  propose a full config under the reserved draft id (AGENT_DRAFT_ID); this
 *  page adopts that proposal into the form as an unsaved create, and the user
 *  commits it with Create. Submitting navigates to /team/<id>/edit, where the
 *  chat targets the real agent config. */
export default function NewAgentEditPage() {
  const [draft, setDraft] = useState<AgentDraft | null>(null);

  // Same SSE + adopt mechanism as the edit page, on the draft id: no agent
  // row exists yet, so the form is the adoption surface.
  useAgentConfigEvents(AGENT_DRAFT_ID, {
    onProposed: (config) => setDraft(agentConfigToDraft(config)),
  });

  return (
    <AgentEditorLayout
      header={
        <PageHeader
          breadcrumb={[
            { label: "Team", href: "/team" },
            { label: "Agents", href: "/team" },
            { label: "New Agent" },
          ]}
          title="Create Agent"
        />
      }
      left={<AgentForm alwaysOpen draft={draft ?? undefined} />}
      chat={
        <ChatPanel
          conversationId={`agent:chat:${AGENT_DRAFT_ID}`}
          title="Chat"
          contextBlock={[
            "<agent-context>",
            `<agentId>${AGENT_DRAFT_ID}</agentId>`,
            "<name>New Agent</name>",
            "<state>creating</state>",
            "</agent-context>",
          ]
            .filter(Boolean)
            .join("\n")}
          placeholder="Describe the agent you want — it fills the form…"
          suggestions={[
            "A code reviewer on my own model, approval on",
            "An archivist that keeps notes, reasoning effort high",
            "A researcher with web access, auto permission",
          ]}
        />
      }
    />
  );
}
