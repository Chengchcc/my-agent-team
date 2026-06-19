import { afterEach, describe, expect, mock, test } from "bun:test";
import { createSubmitDeliverableTool } from "./submit-deliverable-tool.js";

describe("createSubmitDeliverableTool", () => {
  afterEach(() => {
    mock.restore();
  });

  test("execute sends correct URL, headers, and body", async () => {
    const fetches: Request[] = [];
    globalThis.fetch = mock(async (input: string, init?: RequestInit) => {
      fetches.push(new Request(input, init));
      return new Response('{"deliverable":{"deliverableId":"d_001"}}', { status: 201 });
    });

    const tool = createSubmitDeliverableTool({
      backendUrl: "http://localhost:3000",
      backendAuthToken: "tok_123",
      issueId: "iss_001",
      fromStatus: "planned",
      runId: "run_001",
    });

    const result = await tool.execute({
      kind: "plan",
      fields: { summary: "Build login" },
      ref: "https://doc.example/plan",
    });

    expect(result.isError).toBeUndefined();
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.url).toBe("http://localhost:3000/api/issues/iss_001/deliverables");
    expect(fetches[0]!.method).toBe("POST");
    expect(fetches[0]!.headers.get("x-auth-token")).toBe("tok_123");

    const body = await fetches[0]!.json();
    expect(body.kind).toBe("plan");
    expect(body.fields).toEqual({ summary: "Build login" });
    expect(body.ref).toBe("https://doc.example/plan");
    expect(body.fromStatus).toBe("planned");
    expect(body.runId).toBe("run_001");
    expect(body.idempotencyKey).toBe("issue:iss_001:planned:deliverable");
  });

  test("non-2xx returns isError:true (does not throw)", async () => {
    globalThis.fetch = mock(
      async () => new Response('{"error":"not found"}', { status: 404 }),
    );

    const tool = createSubmitDeliverableTool({
      backendUrl: "http://localhost:3000",
      backendAuthToken: null,
      issueId: "iss_001",
      fromStatus: "planned",
      runId: "run_001",
    });

    const result = await tool.execute({ kind: "plan", fields: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("HTTP 404");
  });
});
