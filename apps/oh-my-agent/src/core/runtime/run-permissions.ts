import { randomUUID } from "node:crypto";
import type { AIMessageChunk, JsonSchema, Message } from "@chengchenccc/message";
import { CONSENTED_MCP_TOOLS_ENV, decodeEnvList } from "@chengchenccc/message";
import type { PluginTool, SessionStore } from "../index.js";
import type { RuntimeKnobs } from "../settings/project-settings.js";
import { requestApproval } from "./approval.js";
import {
  classifyPermissionAction,
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  isCriticalDeletion,
} from "./permission-classifier.js";
import { findMatchingPermissionRule } from "./permission-rules.js";
import type { RunRuntimeDeps } from "./run-runtime.js";

export type RunModelStream = (
  messages: readonly Message[],
  signal?: AbortSignal,
  tools?: readonly PluginTool[],
  modelIdOverride?: string,
  responseFormat?: JsonSchema,
) => AsyncIterable<AIMessageChunk>;

/** One session's permission gate verdict. */
export type SessionPermissionGate = (
  toolName: string,
  input: unknown,
  callId: string,
) => Promise<{ block: boolean; reason?: string } | undefined>;

const HIGH_RISK_NATIVE_TOOLS: Record<string, true> = {
  bash: true,
  browser: true,
  eval: true,
  write: true,
  edit: true,
  orchestrate: true,
  workflow_run: true,
  learn: true,
  manage_skill: true,
};

const isAskGatedName = (name: string): boolean =>
  HIGH_RISK_NATIVE_TOOLS[name] === true || name.startsWith("mcp__");

/** Permission-gate stage (ADR 0020): "deny" blocks outright; "ask" routes
 *  high-risk tools through the approval pipeline; "auto" routes
 *  effect-escaping tools through the classifier with one human escalation
 *  per unique action. */
export function createRunPermissionGates(
  deps: RunRuntimeDeps,
  ctx: {
    knobs: RuntimeKnobs;
    store: SessionStore;
    streamModel: RunModelStream;
    pluginCodeToolNames: ReadonlySet<string>;
    approvalDeadlineMs: number;
    bashSandboxed: boolean;
  },
): {
  permissionGate: SessionPermissionGate | undefined;
  makeSessionPermissionGate: (intentTexts: readonly string[]) => SessionPermissionGate;
} {
  const { knobs, store, streamModel, pluginCodeToolNames, approvalDeadlineMs, bashSandboxed } = ctx;
  const CONSENTED_MCP_TOOLS = new Set(decodeEnvList(process.env[CONSENTED_MCP_TOOLS_ENV]));
  const isConsentedProductTool = (toolName: string): boolean => CONSENTED_MCP_TOOLS.has(toolName);
  const classifierGated = (toolName: string, input: unknown): boolean =>
    !isConsentedProductTool(toolName) &&
    (toolName === "bash" ||
      toolName === "browser" ||
      toolName === "eval" ||
      toolName === "orchestrate" ||
      toolName === "workflow_run" ||
      toolName === "manage_skill" ||
      (toolName === "learn" && (input as { skill?: unknown } | null)?.skill !== undefined) ||
      toolName.startsWith("mcp__") ||
      pluginCodeToolNames.has(toolName));

  const escalatedActions = new Set<string>();
  const USER_INTENT_SOURCES = new Set(["prompt", "steer", "follow_up"]);
  const recentUserTexts = async (): Promise<string[]> => {
    try {
      const entries = await store.readBranch(deps.runId);
      return entries
        .filter(
          (e) =>
            e.type === "message" &&
            (e as { role?: string }).role === "user" &&
            USER_INTENT_SOURCES.has((e as { source?: string }).source ?? ""),
        )
        .map((e) => ((e as { message?: { text?: string } }).message?.text ?? "").slice(0, 800))
        .filter((t) => t.length > 0)
        .slice(-5);
    } catch {
      return [];
    }
  };

  const alwaysAllowed = new Set<string>();
  const alwaysDenied = new Set<string>();
  const allowRules = new Set<string>(knobs.permissionRules?.allow ?? []);
  const denyRules = new Set<string>(knobs.permissionRules?.deny ?? []);

  const matchDenyRule = (toolName: string, input: unknown): string | undefined =>
    findMatchingPermissionRule(denyRules, toolName, input, {
      workspaceRoot: deps.workspaceRoot,
      mode: "deny",
    });
  const matchAllowRule = (toolName: string, input: unknown): string | undefined =>
    findMatchingPermissionRule(allowRules, toolName, input, {
      workspaceRoot: deps.workspaceRoot,
      mode: "allow",
    });

  const autoGateDecision = async (
    toolName: string,
    input: unknown,
    callId: string,
    userTexts: readonly string[],
  ): Promise<{ block: boolean; reason?: string } | undefined> => {
    if (toolName === "bash" && isCriticalDeletion((input as { command?: string })?.command ?? "")) {
      return {
        block: true,
        reason: `${toolName}: critical-path deletion (root/top-level/home target) — re-issue with a narrower named path`,
      };
    }
    const deniedByRule = matchDenyRule(toolName, input);
    if (deniedByRule) {
      return { block: true, reason: `${toolName}: blocked by permission rule (${deniedByRule})` };
    }
    if (alwaysDenied.has(toolName)) {
      return { block: true, reason: `${toolName}: denied for this run by the user` };
    }
    if (alwaysAllowed.has(toolName) || matchAllowRule(toolName, input)) return undefined;
    const verdict = await classifyPermissionAction({
      toolName,
      input,
      userTexts,
      stream: (messages, signal, modelIdOverride) =>
        streamModel(messages, signal, undefined, modelIdOverride),
      timeoutMs: knobs.permissionClassifierTimeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS,
      ...(knobs.permissionClassifierModel ? { modelId: knobs.permissionClassifierModel } : {}),
    });
    if (verdict.verdict === "allow") return undefined;
    const actionKey = `${toolName}:${JSON.stringify(input)}`;
    if (!deps.approvalHandler || escalatedActions.has(actionKey)) {
      return {
        block: true,
        reason: `${toolName}: blocked by classifier — ${verdict.reason}`,
      };
    }
    escalatedActions.add(actionKey);
    const escalation: {
      callId: string;
      toolName: string;
      input: unknown;
      reason: string;
      source: "classifier";
      sandboxed?: boolean;
    } = {
      callId: callId || `cls-${randomUUID().slice(0, 8)}`,
      toolName,
      input,
      reason: `classifier: ${verdict.reason}`,
      source: "classifier",
    };
    if (toolName === "bash") escalation.sandboxed = bashSandboxed;
    const human = await requestApproval(deps.approvalHandler, escalation, approvalDeadlineMs);
    if (human.decision === "allow_always") {
      alwaysAllowed.add(toolName);
      return undefined;
    }
    if (human.decision === "allow_rule") {
      if (human.rule) allowRules.add(human.rule);
      return undefined;
    }
    if (human.decision === "allow") return undefined;
    if (human.decision === "deny_always") {
      alwaysDenied.add(toolName);
      return {
        block: true,
        reason: `${toolName}: denied for this run by the user`,
      };
    }
    return {
      block: true,
      reason: `${toolName}: blocked by classifier — ${verdict.reason} (human denied)`,
    };
  };

  const makeSessionPermissionGate =
    (intentTexts: readonly string[]) =>
    async (
      toolName: string,
      input: unknown,
      callId: string,
    ): Promise<{ block: boolean; reason?: string } | undefined> => {
      const ungated = deps.permissionMode === undefined || deps.permissionMode === "yolo";
      if (ungated) return undefined;
      if (deps.permissionMode === "auto") {
        if (!classifierGated(toolName, input)) return undefined;
        try {
          return await autoGateDecision(toolName, input, callId, [
            ...intentTexts,
            ...(await recentUserTexts()),
          ]);
        } catch (err) {
          return {
            block: true,
            reason: `${toolName}: permission gate error — ${
              err instanceof Error ? err.message : String(err)
            }`,
          };
        }
      }
      if (
        (!isAskGatedName(toolName) && !pluginCodeToolNames.has(toolName)) ||
        isConsentedProductTool(toolName)
      ) {
        return undefined;
      }
      if (deps.permissionMode === "deny") {
        return { block: true, reason: `${toolName}: blocked by permissionMode=deny` };
      }
      const deniedByRule = matchDenyRule(toolName, input);
      if (deniedByRule) {
        return { block: true, reason: `${toolName}: blocked by permission rule (${deniedByRule})` };
      }
      if (alwaysDenied.has(toolName)) {
        return { block: true, reason: `${toolName}: denied for this run by the user` };
      }
      if (alwaysAllowed.has(toolName) || matchAllowRule(toolName, input)) return undefined;
      if (!deps.approvalHandler) {
        return {
          block: true,
          reason: `${toolName}: approval required but no pipeline configured`,
        };
      }
      const approvalInput: {
        callId: string;
        toolName: string;
        input: unknown;
        source: "permission";
        sandboxed?: boolean;
      } = {
        callId: callId || `perm-${randomUUID().slice(0, 8)}`,
        toolName,
        input,
        source: "permission",
      };
      if (toolName === "bash") approvalInput.sandboxed = bashSandboxed;
      let verdict: { decision: string; rule?: string; reason?: string };
      try {
        verdict = await requestApproval(deps.approvalHandler, approvalInput, approvalDeadlineMs);
      } catch (err) {
        return {
          block: true,
          reason: `${toolName}: approval pipeline error — ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      if (verdict.decision === "allow") return undefined;
      if (verdict.decision === "allow_rule") {
        if (verdict.rule) allowRules.add(verdict.rule);
        return undefined;
      }
      if (verdict.decision === "allow_always") {
        alwaysAllowed.add(toolName);
        return undefined;
      }
      if (verdict.decision === "deny_always") {
        alwaysDenied.add(toolName);
        return {
          block: true,
          reason: `${toolName}: denied for this run by the user`,
        };
      }
      return {
        block: true,
        reason: `${toolName}: denied — ${verdict.reason ?? "user denied"}`,
      };
    };

  const permissionGate =
    deps.permissionMode === undefined ? undefined : makeSessionPermissionGate([]);
  return { permissionGate, makeSessionPermissionGate };
}
