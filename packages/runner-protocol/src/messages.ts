import type { Message } from "@my-agent-team/core";
import type { AgentEvent } from "@my-agent-team/framework";

export type HostToRunner =
  | {
      type: "start";
      runId: string;
      spec: Record<string, unknown>;
      reflect?: boolean;
      /** Messages already projected into the backend checkpointer by broadcastMessage().
       *  The daemon seeds its own checkpointer with these before creating the agent,
       *  so conversation context is visible to checkpointer.load(). */
      preloadedMessages?: readonly Message[];
    }
  | { type: "abort"; runId: string }
  | { type: "run_finalized"; runId: string };

export type RunnerToHost =
  | { type: "run_started"; runId: string; parentRunId: string; threadId: string; kind: "reflect" }
  | { type: "event"; runId: string; event: AgentEvent }
  | { type: "delta"; runId: string; event: AgentEvent }
  | { type: "heartbeat"; runId: string }
  | {
      type: "run_done";
      runId: string;
      status: "succeeded" | "error" | "aborted";
      wantsReflect?: boolean;
      error?: string;
    };

export type ProtocolMessage = HostToRunner | RunnerToHost;
