import type { Message } from "@chengchenccc/message";
import type {
  AgentContextPort,
  IdGenerator,
  LedgerMessageResolver,
} from "../agent-context/ports.js";
import type { RunTokenRegistry } from "../product-tools/run-token-registry.js";
import type { WorkspaceLockRegistry } from "../project/workspace-lock.js";
import type { AgentRun } from "./domain.js";
import type { AgentRunPort } from "./ports.js";
import type {
  BackendEvent,
  BackendRegistry,
  BackendRunOutcome,
  BackendRunSegment,
  WorkspaceBinding,
} from "./protocol/index.js";
import type { RecallHit } from "./recall.js";

export interface AgentRunExecutionDeps {
  /** Every live run event, as broadcast: the composition root turns the chat-shaped ones into
   *  AHP actions (ADR 0040 decision 4). Observation only. */
  readonly onLiveEvent?: (runId: string, event: BackendEvent) => void;
  readonly runPort: AgentRunPort;
  readonly contextPort: AgentContextPort;
  /** ADR 0055: the recall computed for this dispatch, published so the
   *  product tool can consult it when the model dispatches with gaps. */
  readonly onRecall?: (runId: string, hits: readonly RecallHit[]) => void;
  /** ADR 0055: recall searches this conversation's ledger. Structural (not the
   *  full ConversationPort) so a test can pass a stub. */
  readonly conversationSearch?: (
    keyword: string,
    limit?: number,
    scope?: { conversationId?: string },
  ) => ReadonlyArray<{ seq: number; ts: number; snippet: string }>;
  /** ADR 0064: the front desk's long-term memory, when this deployment can
   *  reach it. Absent = recall reports the source as skipped. */
  /** ADR 0080: tracked work, recalled like memory. Absent = skipped. */
  readonly searchRequirements?: (
    query: string,
    limit: number,
  ) => ReadonlyArray<{
    requirementId: string;
    title: string;
    goal: string;
    status: string;
    at: number;
  }>;
  readonly searchMemory?: (input: {
    conversationId: string;
    query: string;
    limit: number;
  }) => Promise<
    ReadonlyArray<{
      id: string;
      content: string;
      source: string;
      at: number;
      why: string;
      score?: number;
    }>
  >;
  readonly ledgerResolver: LedgerMessageResolver;
  /** Per-kind dispatch table: `modelRef.backendKind` resolves the Backend
   *  and its catalog. Partial — a kind a deployment does not register gets
   *  a clear preflight error, never a silent fallback. */
  readonly backends: BackendRegistry;
  readonly idGen: IdGenerator;
  /** Wall-clock cap on a run (ms); the dispatch watchdog stops the
   *  backend and settles aborted on expiry. */
  readonly runTimeoutMs?: number;
  /** How long a run may go WITHOUT any event before the dispatch stops it
   *  (ms, 0 disables). The loop heartbeats every few seconds, so silence
   *  means the child stopped reporting - a wedged bootstrap or model call
   *  (live 2026-09-25: two runs sat mute until a human cancelled them, as
   *  nothing but the 30-minute wall clock would have ended them). */
  readonly silenceWindowMs?: number;
  /** Daily spend brake, checked once per dispatch before the model preflight:
   *  an unattended cron that keeps spawning runs must not be able to spend
   *  without a ceiling. Absent means no cap (the product default). */
  readonly budgetGate?: {
    assertWithinDailyBudget(): Promise<void>;
  };
  readonly resolveWorkspace: (input: {
    conversationId: string;
    agentId: string;
    /** ADR 0077: the run being resolved, so it can be linked to the
     *  requirement whose checkout it gets. Absent for lookups that are not
     *  about a run (none today). */
    runId?: string;
  }) => Promise<WorkspaceBinding>;
  /** Product Tools MCP endpoint the Oma child connects to
   *  (`sse:<url>`), from PRODUCT_TOOLS_MCP_URL. */
  readonly productToolsEntrypoint: string;
  /** Per-run product-tools bearer registry; minted at dispatch, revoked
   *  in dispatchFn's finally (every terminal path). */
  readonly productToolsTokenRegistry: RunTokenRegistry;
  /** Shared per-worktree lock (A4): run dispatch, loop clean-start/reset
   *  and agent detach serialize on the same roots. */
  readonly workspaceLocks: WorkspaceLockRegistry;
  /** H1: overwrite the run's workspace `.mcp.json` (+ product-tools
   *  manifest) from the DB source of truth immediately before spawn, so a
   *  run can never mount an agent-tampered config (forged product-tools
   *  server / run-token exfiltration). May return extracted secret env vars
   *  and their expandable names for spawn env injection. Absent (tests) = skip. */
  readonly rewriteWorkspaceBridge?: (
    agentId: string,
    root: string,
  ) => Promise<{ env: Record<string, string>; expandableVars: string[] } | undefined>;
  /** Called after a completed run's Product commit (History Message +
   *  Context ref) lands atomically. Fired on the original commit AND on
   *  retryTerminalCommit replay - consumers must be idempotent per
   *  (runId, ...). Used by Conversation for the mention cascade. */
  readonly onRunCommitted?: (
    runId: string,
    output: Message | undefined,
    committedSeq: readonly number[],
  ) => void;
  /** ADR 0060 D6: recovery found a terminal dispatched run whose notice was
   *  never confirmed (crash between the commit and the delivery). The closure
   *  re-runs the same notification; it must stay idempotent per runId. */
  /** ADR 0072/0076: the DELIVERY GATE. Called before a completed run's
   *  terminal commit; returns a note to append to the answer, or undefined.
   *  The front desk may write anything about verification - this line is the
   *  backend's own fact, so "someone checked this" can never be claimed by
   *  the model alone (live 2026-11-23 a change shipped with no second agent
   *  and the answer simply said "done"). */
  readonly deliveryNote?: (
    run: AgentRun,
    outcome: BackendRunOutcome,
  ) => Promise<string | undefined>;
  readonly onRunResultUndelivered?: (run: AgentRun) => void;
  /** Called when a human input request is settled - answered, replayed, or timed out. The
   *  surface layer turns it into whatever its channel says ("the card stops being pending"); the
   *  product states the outcome and does not decide how it is shown. Repeated for replays, so
   *  consumers must be idempotent. */
  readonly onHumanInputResolved?: (input: {
    runId: string;
    callId: string;
    outcome: "allow" | "deny" | "timeout";
  }) => void;
  /** Conversation title lookup for the auto-title retry flag. */
  /** Called after a failed/aborted/timeout run settles, so the surface can
   *  persist an assistant error message (T3-2: failures survive refresh).
   *  Fired once per terminal settle; consumers must be idempotent per runId. */
  readonly onRunFailed?: (input: {
    runId: string;
    conversationId: string;
    agentId: string;
    error: string;
  }) => void;
  /** Called in dispatchFn's finally when a run exits (completed, failed,
   *  aborted, or preflight error) so auxiliary run-scoped resources (such as
   *  parked in-memory ask timers/resolvers) are released immediately. */
  readonly onRunTerminated?: (runId: string) => void;
  /** Durable telemetry sink for normalized run events (tool calls, status,
   *  workflow steps). Wired to the RuntimeOps event store; failures are
   *  swallowed — telemetry never affects the run. */
  readonly persistRunEvent?: (runId: string, event: BackendEvent) => Promise<void>;
  /** Runtime MCP mount observation (backend.oma.mcp_mount_result). Wired to
   *  the MCP catalog's runtime-status store; absent = observation dropped. */
  readonly onMcpMountResult?: (input: {
    serverName: string;
    ok: boolean;
    toolsCount: number;
    error?: string;
    runId: string;
  }) => void;
  /** Durable approvals v1 (the core `approval_requested` fan-out): persist a
   *  pending action so an approval survives refresh/restart. Wired to the
   *  agent-run port with a deterministic actionId (`runId:callId`) for
   * idempotency; failures are logged, never fatal. */
  readonly onApprovalRequest?: (input: {
    runId: string;
    callId: string;
    payload: Readonly<Record<string, unknown>>;
  }) => Promise<void>;
  /** ADR 0075: a request just parked. Fire-and-forget — the notification must
   *  never delay the event a card is waiting for. */
  readonly onRequestCreated?: (input: {
    runId: string;
    callId: string;
    kind: string;
    payload: Readonly<Record<string, unknown>>;
  }) => void;
}

export interface LiveRun {
  readonly segment: BackendRunSegment;
}

export interface AgentRunExecutionService {
  dispatch(runId: string): Promise<void>;
  /** Steer injection into the live run of a branch. Explicit failure (input
   *  cancelled) when no live run exists - never a silent conversion. */
  injectSteer(
    branchId: string,
    input: { inputId: string; message: Message },
    opts?: { keepIfIdle?: boolean },
  ): Promise<void>;
  /** True when the run has a live in-process child (steer/abort routable).
   *  DB-active is NOT sufficient: after a restart or a pre-acceptance
   *  failure the Run row can be active with no live child (a zombie). */
  isLive(runId: string): boolean;
  /** True while the run's dispatch is in flight (pre-acceptance phases or
   *  settling) even without a live child yet. "owned" = isLive || isInflight;
   *  only a run that is neither is a true zombie. */
  isInflight(runId: string): boolean;
  /** Terminal a DB-active run that has NO live child (zombie): Run aborted,
   *  bound input cancelled, branch released. Only used by the auto-steer
   *  fallback; explicit steer never silently converts. */
  abortStaleRun(runId: string): Promise<void>;
  /** Shutdown: reject new dispatches, dispose the Backend (abort/SIGTERM/
   *  SIGKILL every child, awaiting their exit), then drain every in-flight
   *  dispatch so the DB is only closed after all terminal settles. */
  dispose(): Promise<void>;
  recover(): Promise<void>;
  retryTerminalCommit(runId: string): Promise<void>;
  stop(runId: string): Promise<void>;
  /** Resolve a pending HITL approval in the live run (spec: approval
   *  pipeline Phase B). Explicit failure when no live child exists. */
  /** The `*_always` decisions cover every later call of the same tool for the
   *  rest of the run (the agent's own always-options); a backend that has no
   *  such option degrades to the one-shot equivalent, never to a promise it
   *  cannot keep. */
  resolveApproval(
    runId: string,
    callId: string,
    decision: "allow" | "allow_always" | "deny" | "deny_always",
  ): Promise<void>;
  /** ADR 0038: stash a parked run's decided actions and re-dispatch it
   * (answer arrived with no live child after a restart). No-op when the
   * run still waits on siblings or has a live loop. Also the wake hook for
   * product-tools ask resolves. */
  resumeParkedRun(runId: string): Promise<void>;
  /** Push a run-scoped event onto the live bus: the observer hooks see it, and whatever is
   *  keeping a durable log keeps it. */
  broadcastRunEvent(runId: string, event: BackendEvent): void;
}
