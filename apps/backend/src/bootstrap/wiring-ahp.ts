import { chatUri } from "@chengchenccc/ahp-client";
import type { BackendConfig } from "../config.js";
import type { AgentService } from "../features/agent/index.js";
import type { AgentRunPort } from "../features/agent-run/ports.js";
import {
  createAhpChatWriter,
  createAhpHost,
  createAhpStateSource,
  type RunTurnContext,
} from "../features/ahp/index.js";
import type { ArtifactService } from "../features/artifact/index.js";
import type { ConversationPort } from "../features/conversation/index.js";
import type { HarnessCatalog } from "../features/models/index.js";
import type { RuntimeOpsStore } from "../features/runtime-ops/index.js";

export interface AhpWiringDeps {
  config: BackendConfig;
  agentSvc: AgentService;
  harnessCatalog: HarnessCatalog;
  convPort: ConversationPort;
  agentRunPort: AgentRunPort;
  artifactService: ArtifactService;
  opsStore: RuntimeOpsStore;
  peekWorkspaceFor: (input: {
    conversationId: string;
    agentId: string | null;
  }) => Promise<{ root: string } | null>;
}

/** Wire the AHP read-only state source, WebSocket host, and live chat writer
 *  in dependency order (zero forward-reference TDZ closures). */
export function wireAhp(deps: AhpWiringDeps) {
  const {
    config,
    agentSvc,
    harnessCatalog,
    convPort,
    agentRunPort,
    artifactService,
    opsStore,
    peekWorkspaceFor,
  } = deps;

  const browserWsBase = `ws://${
    config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host
  }:${config.port}`;

  const ahpSource = createAhpStateSource({
    listAgents: async () =>
      (await agentSvc.list(false)).map((agent) => ({
        id: agent.id,
        name: agent.config.name,
        harness: agent.config.runtime_config.harness,
        model: agent.config.runtime_config.model,
      })),
    harnessModels: async (harness) =>
      (await harnessCatalog.list()).find((h) => h.key === harness)?.models ?? [],
    getConversation: (conversationId) => convPort.getConversation(conversationId),
    getLedgerEntries: (conversationId) => convPort.getLedgerEntries(conversationId),
    listPendingInputs: async (conversationId) =>
      (await agentRunPort.listInputsForConversation(conversationId)).map((input) => ({
        runId: input.runId,
        message: JSON.stringify(input.message),
      })),
    listPendingActions: async (runId) =>
      (await agentRunPort.listPendingActions(runId)).map((action) => ({
        actionId: action.actionId,
        kind: action.kind,
        status: action.status,
        payload: JSON.stringify(action.payload),
        response: action.response === null ? null : JSON.stringify(action.response),
      })),
    getRun: (runId) => agentRunPort.getRun(runId),
    listActiveRuns: (conversationId) =>
      agentRunPort.listRecentRunsForConversations([conversationId], 10 * 60_000).catch(() => []),
    workspaceRootOf: async (conversationId) => {
      const row = convPort.getConversation(conversationId);
      const workspace = await peekWorkspaceFor({
        conversationId,
        agentId: row?.agentId ?? null,
      }).catch(() => null);
      return workspace?.root ?? null;
    },
    latestRunTodo: async (runId) => {
      const run = await agentRunPort.getRun(runId);
      return run ? agentRunPort.getLatestRunTodo(run.branchId) : null;
    },
    toolActivities: async (runId) => {
      const activities = new Map<string, string>();
      for (const event of opsStore.listRunEvents(runId, 2000)) {
        if (event.type !== "native_tool_started") continue;
        const callId = event.data.callId;
        const activity = event.data.activity;
        if (typeof callId === "string" && typeof activity === "string") {
          activities.set(callId, activity);
        }
      }
      return activities;
    },
  });

  const ahpHost = createAhpHost({
    wsBase: browserWsBase,
    source: ahpSource,
  });

  const readRunTurn = async (runId: string): Promise<RunTurnContext | null> => {
    const run = await agentRunPort.getRun(runId).catch(() => null);
    if (!run) return null;
    const inputs = await agentRunPort.listInputs(run.branchId).catch(() => []);
    const input = inputs.find((candidate) => candidate.runId === runId);
    return {
      conversationId: run.conversationId,
      inputText: input?.message.text ?? "",
      ...(input?.message.id === undefined ? {} : { messageId: input.message.id }),
      startedAt: new Date(run.createdAt).toISOString(),
      status: run.status,
    };
  };

  const chatWriter = createAhpChatWriter({
    dispatch: (uri, action) => ahpHost.server.dispatch(uri, action),
    invalidate: (uri) => ahpHost.server.invalidate(uri),
    saveImage: async ({ runId, conversationId, mediaType, base64 }) => {
      const ext =
        mediaType === "image/png"
          ? "png"
          : mediaType === "image/jpeg"
            ? "jpg"
            : mediaType === "image/gif"
              ? "gif"
              : "webp";
      const meta = await artifactService.upload({
        folder: `tool-images/${conversationId}`,
        filename: `${runId}-${Date.now()}.${ext}`,
        content: base64,
        encoding: "base64",
        source: { runId, conversationId },
      });
      return { uri: meta.url, contentType: meta.mimeType, size: meta.size };
    },
    projectedTurn: async (conversationId, turnId) => {
      const chat = await ahpSource.chat(chatUri(conversationId)).catch(() => null);
      return chat?.turns.find((candidate) => candidate.id === turnId) ?? null;
    },
    readRunTurnContext: readRunTurn,
  });

  return { browserWsBase, ahpSource, ahpHost, chatWriter };
}
