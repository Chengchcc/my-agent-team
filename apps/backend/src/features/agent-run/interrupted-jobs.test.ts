import { describe, expect, test } from "bun:test";
import {
  deriveInterruptedJobs,
  type JobStateEvent,
  renderInterruptedJobs,
} from "./interrupted-jobs.js";

const job = (state: string, jobId = "bg_1"): JobStateEvent => ({
  type: "backend.acp.job_state",
  data: { type: "job_state", jobId, jobKind: "bash", label: `sleep ${jobId}`, state },
});

describe("ADR 0063 interrupted jobs are derived, not marked", () => {
  test("a started job with no end was cut off with its run", () => {
    expect(deriveInterruptedJobs([job("started"), job("started", "bg_2")])).toEqual([
      { jobId: "bg_1", jobKind: "bash", label: "sleep bg_1" },
      { jobId: "bg_2", jobKind: "bash", label: "sleep bg_2" },
    ]);
  });

  test("a job that reported any terminal state is not interrupted", () => {
    // Teardown kills the child and bash reports failed/exit 137: that is an
    // END, so the fact "it was cut off" is the crash case (no end at all).
    expect(deriveInterruptedJobs([job("started"), job("failed")])).toEqual([]);
    expect(deriveInterruptedJobs([job("started"), job("finished")])).toEqual([]);
    expect(deriveInterruptedJobs([job("started"), job("cancelled")])).toEqual([]);
  });

  test("rows from other event types and malformed payloads are ignored", () => {
    expect(
      deriveInterruptedJobs([
        { type: "native_tool_started", data: { jobId: "x", state: "started" } },
        { type: "backend.acp.job_state", data: { jobId: 5, state: "started" } },
        { type: "backend.acp.job_state", data: {} },
      ]),
    ).toEqual([]);
  });
});

describe("the next turn's block", () => {
  test("says nothing when nothing was cut off", () => {
    expect(renderInterruptedJobs([])).toBe("");
  });

  test("names the jobs and forbids blind replay", () => {
    const block = renderInterruptedJobs([{ jobId: "bg_1", jobKind: "bash", label: "bun test" }]);
    expect(block).toContain("bun test");
    expect(block).toContain("Nothing was replayed");
    // The model must weigh side effects before re-running: a replayed
    // `git push` is worse than a lost test run.
    expect(block).toMatch(/side effects/i);
  });
});
