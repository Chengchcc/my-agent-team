import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AcpBackend } from "@chengchenccc/adapter-acp";

/** The scripted ACP child the agent-run suites drive (ADR 0040 R3): a real
 *  process on the ACP wire, with its JSONL record file as the assertions'
 *  eyes inside the child. */
const FIXTURE = new URL(
  "../../../../../packages/adapter-acp/src/__fixtures__/fake-acp-harness.ts",
  import.meta.url,
).pathname;

type ScriptStep = Record<string, unknown>;

export interface FakeAcpDaemonOptions {
  readonly dataDir: string;
  readonly failFirstExecute?: boolean;
  readonly outcomeDelayMs?: number;
  readonly toolTodo?: boolean;
  readonly text?: string;
  /** Raw fixture steps (overrides the sugar flags). */
  readonly script?: readonly ScriptStep[];
}

export interface FakeAcpDaemon {
  readonly backend: AcpBackend;
  readonly modelCatalog: {
    list: () => Promise<{ models: Array<{ id: string; available: boolean }> }>;
  };
  /** One entry per FRESH ACP session (session/load resumes an existing
   *  session and therefore does not appear here). */
  readonly executeCalls: Array<{ workspaceRoot: string }>;
  /** Product-tools bearers the children received through spawn env. */
  readonly executeTokens: string[];
  /** Prompt text per executed turn, in order (fresh and resumed alike). */
  readonly executeMessages: string[];
  /** Approval callIds replayed through resume _meta (session/new adopt or
   *  session/load alike). */
  readonly resumeCalls: string[][];
}

/** Unique record files matter: several daemons share one suite dataDir, and
 *  every assertion below reads only its own child's wire record. */
let daemonSeq = 0;

function scriptFor(opts: FakeAcpDaemonOptions): readonly ScriptStep[] {
  if (opts.script !== undefined) return opts.script;
  if (opts.failFirstExecute) return [{ prompt_error: "boom" }];
  if (opts.outcomeDelayMs !== undefined) return [{ delay_ms: opts.outcomeDelayMs }];
  if (opts.toolTodo) {
    return [
      {
        plan: [
          { content: "step 1", status: "completed" },
          { content: "step 2", status: "pending" },
        ],
      },
      { tool_call: { id: "call-1", name: "ls", output: { empty: true } } },
      { text: "done" },
    ];
  }
  return [{ text: opts.text ?? "done" }];
}

function readRecord(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function createFakeAcpDaemon(opts: FakeAcpDaemonOptions): FakeAcpDaemon {
  const steps = scriptFor(opts);
  const recordPath = join(opts.dataDir, `acp-daemon-${daemonSeq++}.jsonl`);
  const backend = new AcpBackend({
    commands: { oma: [process.execPath, FIXTURE] },
    env: {
      FAKE_ACP_SCRIPT: JSON.stringify(steps),
      FAKE_ACP_RECORD: recordPath,
    },
  });
  return {
    backend,
    /** A stub catalog: dispatch preflight only needs `acp/oma` listed, and a
     *  catalog probe would spawn another child (slow, irrelevant here). */
    modelCatalog: {
      list: async () => ({ models: [{ id: "acp/oma", available: true }] }),
    },
    /** One entry per FRESH ACP session (session/load resumes an existing
     *  session and therefore does not appear here). */
    get executeCalls(): Array<{ workspaceRoot: string }> {
      return readRecord(recordPath)
        .filter((line) => line.event === "session/new")
        .map((line) => {
          const params = line.params as { cwd?: unknown };
          return { workspaceRoot: typeof params.cwd === "string" ? params.cwd : "" };
        });
    },
    /** Product-tools bearers the children received through spawn env. */
    get executeTokens(): string[] {
      return readRecord(recordPath)
        .filter((line) => line.event === "spawn_env")
        .map((line) => line.PRODUCT_TOOLS_RUN_TOKEN)
        .filter((value): value is string => typeof value === "string");
    },
    /** Prompt text per executed turn, in order (fresh and resumed alike). */
    get executeMessages(): string[] {
      return readRecord(recordPath)
        .filter((line) => line.event === "prompt")
        .map((line) => line.text)
        .filter((value): value is string => typeof value === "string");
    },
    /** Approval callIds replayed through the resume _meta. A branch ref
     *  resumes with session/load; a parked run whose branch never settled
     *  resumes through session/new's adopt-last-interrupted marker. */
    get resumeCalls(): string[][] {
      return readRecord(recordPath)
        .filter((line) => line.event === "session/new" || line.event === "session/load")
        .map((line) => {
          const params = line.params as {
            _meta?: { "my-agent-team/resume"?: { decisions?: unknown[] } };
          };
          const decisions = params._meta?.["my-agent-team/resume"]?.decisions ?? [];
          return decisions
            .map((decision) => (decision as { callId?: unknown }).callId)
            .filter((callId): callId is string => typeof callId === "string");
        });
    },
  };
}
