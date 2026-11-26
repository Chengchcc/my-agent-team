import { describe, expect, test } from "bun:test";
import {
  type AttentionLike,
  type AwaitingLike,
  approvalRequest,
  awaitingHeadline,
  budgetGateOf,
  type GateLike,
  gateAnswer,
  memberName,
  requestLine,
  resultText,
  todayZones,
} from "./zones";

function awaitingOf(fields: {
  actionId: string;
  kind: string;
  at: number;
  seen?: boolean;
  payload?: Record<string, unknown>;
}): AwaitingLike {
  const payload = fields.payload === undefined ? {} : fields.payload;
  return {
    actionId: fields.actionId,
    runId: `run-${fields.actionId}`,
    conversationId: "room-1",
    agentId: "coder",
    runStatus: "waiting",
    kind: fields.kind,
    payload,
    createdAt: fields.at,
    seen: fields.seen === true,
  };
}

function gateOf(executionId: string, at: number): GateLike {
  return { executionId, workflowId: "nightly-lint", status: "waiting_human", createdAt: at };
}

/** What a pending budget gate carries in its `form` (ADR 0042 §2.4). */
const BUDGET_GATE = {
  budgetGate: { nodeId: "review", from: "reviewer", attempt: 3, maxAttempts: 2, reason: "no" },
};

/** What a pending question gate carries: the questions its form asks. */
const QUESTION_GATE = { questions: [{ id: "q1", question: "Ship it as is" }] };

describe("requestLine", () => {
  test("names the command, the question, or the tool, in that order", () => {
    const command = { toolName: "bash", input: { command: "rm -rf dist" } };
    expect(requestLine(command)).toBe("rm -rf dist");
    expect(requestLine({ input: "  read the notes  " })).toBe("read the notes");
    const ask = { questions: [{ question: "Which branch gets the fix" }] };
    expect(requestLine(ask)).toBe("Which branch gets the fix");
    expect(requestLine({ toolName: "bash" })).toBe("bash");
  });

  test("a payload that is not an object says nothing", () => {
    expect(requestLine(null)).toBe("");
    expect(requestLine("text")).toBe("");
    expect(requestLine({ input: { command: "   " }, toolName: "ls" })).toBe("ls");
  });

  test("cuts a long command to one line", () => {
    expect(requestLine({ input: "x".repeat(400) })).toHaveLength(120);
  });
});

describe("approvalRequest", () => {
  test("reads what an approval is about, and what a decision needs", () => {
    const payload = {
      callId: "call-1",
      toolName: "bash",
      input: { command: "ls" },
      reason: "list the folder",
      deadlineAt: 5_000,
      sandboxed: true,
    };
    expect(approvalRequest(payload)).toEqual({
      callId: "call-1",
      toolName: "bash",
      subject: "ls",
      reason: "list the folder",
      deadlineAt: 5_000,
      sandboxed: true,
    });
  });

  test("a row without a call id cannot be decided, and still names its tool", () => {
    expect(approvalRequest({ toolName: "write_file" })).toEqual({
      callId: null,
      toolName: "write_file",
      subject: "write_file",
      reason: null,
      deadlineAt: null,
      sandboxed: null,
    });
  });

  test("an empty payload reads as an empty request", () => {
    expect(approvalRequest(undefined)).toEqual({
      callId: null,
      toolName: "",
      subject: "",
      reason: null,
      deadlineAt: null,
      sandboxed: null,
    });
  });
});

describe("awaitingHeadline", () => {
  test("an approval names its tool, an ask quotes its first question", () => {
    expect(awaitingHeadline("approval", { toolName: "bash" })).toBe("Approve bash");
    expect(awaitingHeadline("approval", {})).toBe("Approve a tool");
    const ask = { questions: [{ question: "Which folder holds the tests" }] };
    expect(awaitingHeadline("ask", ask)).toBe("Which folder holds the tests");
    expect(awaitingHeadline("ask", {})).toBe("A question for you");
  });
});

describe("a workflow gate's decision", () => {
  test("a budget gate is answered with one word, and reject really is reject", () => {
    expect(gateAnswer(BUDGET_GATE, "reject")).toEqual({ decision: "reject" });
    expect(gateAnswer(BUDGET_GATE, "grant")).toEqual({ decision: "grant" });
  });

  test("a question gate is not decided from Today: its answer is the form's fields", () => {
    expect(gateAnswer(QUESTION_GATE, "reject")).toBeNull();
    expect(gateAnswer(QUESTION_GATE, "grant")).toBeNull();
    expect(gateAnswer(undefined, "grant")).toBeNull();
  });

  test("names the node the gate is about", () => {
    expect(budgetGateOf(BUDGET_GATE)).toEqual({
      nodeId: "review",
      from: "reviewer",
      attempt: 3,
      maxAttempts: 2,
      reason: "no",
    });
  });

  test("a malformed budget marker is not a budget gate", () => {
    expect(budgetGateOf({ budgetGate: { nodeId: "review" } })).toBeNull();
    expect(budgetGateOf({ budgetGate: "review" })).toBeNull();
    expect(budgetGateOf(undefined)).toBeNull();
  });
});

describe("todayZones", () => {
  const attention: AttentionLike = {
    awaitingYou: [
      awaitingOf({
        actionId: "seen-approval",
        kind: "approval",
        at: 1_000,
        seen: true,
        payload: { toolName: "bash", callId: "c-1" },
      }),
      awaitingOf({
        actionId: "new-ask",
        kind: "ask",
        at: 3_000,
        payload: { questions: [{ question: "Which folder" }] },
      }),
      awaitingOf({
        actionId: "new-approval",
        kind: "approval",
        at: 2_000,
        payload: { toolName: "ls" },
      }),
    ],
    waitingAgent: [
      {
        actionId: "w-1",
        runId: "run-w-1",
        conversationId: "room-1",
        agentId: "coder",
        runStatus: "running",
        kind: "approval",
        resolvedAt: 900,
        answeredBy: "agent:default",
      },
    ],
    unread: [
      {
        runId: "run-u-1",
        conversationId: "room-2",
        agentId: "coder",
        status: "completed",
        terminalAt: 800,
        title: "Release notes",
      },
    ],
  };

  test("needs your decision holds approvals, asks and workflow gates", () => {
    const zones = todayZones(attention, [gateOf("exec-1", 1_500)]);
    expect(zones.needs.map((item) => item.kind)).toEqual(["gate", "approval", "ask", "approval"]);
  });

  test("what nobody has looked at comes first, oldest on top; then what was already seen", () => {
    const zones = todayZones(attention, [gateOf("exec-1", 1_500)]);
    const ids = zones.needs.map((item) =>
      item.kind === "gate" ? item.executionId : item.actionId,
    );
    expect(ids).toEqual(["exec-1", "new-approval", "new-ask", "seen-approval"]);
  });

  test("the counts are the three debts", () => {
    const zones = todayZones(attention, [gateOf("exec-1", 1_500)]);
    expect(zones.needs).toHaveLength(4);
    expect(zones.working).toHaveLength(1);
    expect(zones.results).toHaveLength(1);
  });

  test("an approval without a call id cannot be decided from this page", () => {
    const zones = todayZones(attention, []);
    const decidable = zones.needs.filter(
      (item): item is Extract<typeof item, { kind: "approval" }> =>
        item.kind === "approval" && item.canDecide,
    );
    expect(decidable.map((item) => item.actionId)).toEqual(["seen-approval"]);
  });

  test("nothing owed reads as three empty zones", () => {
    expect(todayZones(undefined, [])).toEqual({ needs: [], working: [], results: [] });
  });

  test("a gate alone is one decision, carrying its row", () => {
    const zones = todayZones({ awaitingYou: [], waitingAgent: [], unread: [] }, [
      gateOf("exec-9", 1),
    ]);
    expect(zones.needs).toEqual([
      {
        kind: "gate",
        executionId: "exec-9",
        row: {
          executionId: "exec-9",
          workflowId: "nightly-lint",
          status: "waiting_human",
          createdAt: 1,
        },
      },
    ]);
  });
});

describe("resultText", () => {
  test("joins the assistant's text in order and leaves tool traffic out", () => {
    const outcome = {
      status: "completed",
      messages: [
        { role: "assistant", blocks: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
        { role: "tool", blocks: [{ type: "tool_result", tool_use_id: "t1", content: "a list" }] },
        { role: "assistant", blocks: [{ type: "text", text: "First part." }] },
        { role: "assistant", blocks: [{ type: "text", text: "Second part." }] },
      ],
    };
    expect(resultText(outcome)).toBe("First part.\n\nSecond part.");
  });

  test("a run that ended without text gives an empty string", () => {
    expect(resultText({ status: "failed", error: "boom" })).toBe("");
    expect(resultText({ status: "completed" })).toBe("");
    expect(resultText(null)).toBe("");
  });
});

describe("memberName", () => {
  test("reads a member by its name and falls back to a short id", () => {
    const agents = [{ id: "coder", name: "Coder" }];
    expect(memberName(agents, "coder")).toBe("Coder");
    expect(memberName(agents, "agent-0123456789")).toBe("agent-01");
    expect(memberName(agents, null)).toBe("unknown");
  });
});
