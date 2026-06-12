import type { AgentEvent } from "@my-agent-team/framework";

// ─── Control messages (Host → Runner) ───

export type HostToRunner =
  | { type: "start"; runId: string; spec: Record<string, unknown>; reflect?: boolean }
  | { type: "abort"; runId: string }
  /** Backend ACK after completing run_done side effects (status, lock release, D19).
   *  Daemon fires reflection only after receiving this. */
  | { type: "run_finalized"; runId: string };

// ─── Event + lifecycle messages (Runner → Host) ───

export type RunnerToHost =
  | {
      type: "run_started";
      runId: string;
      parentRunId: string;
      threadId: string;
      kind: "reflect";
    }
  | { type: "event"; runId: string; event: AgentEvent }
  | { type: "delta"; runId: string; event: AgentEvent }
  | { type: "heartbeat"; runId: string }
  | {
      type: "run_done";
      runId: string;
      status: "succeeded" | "error" | "aborted";
      wantsReflect?: boolean;
    };

// ─── Union ───

export type ProtocolMessage = HostToRunner | RunnerToHost;
