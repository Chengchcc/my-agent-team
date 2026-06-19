import type { Tool } from "@my-agent-team/core";

/**
 * M18.5: Create a `submit_deliverable` tool for issue runs.
 * The tool POSTs structured deliverables to the backend's
 * POST /api/issues/:issueId/deliverables endpoint.
 *
 * Unlike start_new_conversation (which throws on failure), this tool
 * returns { isError: true } — deliverable submission is best-effort
 * and should not crash the entire run.
 */
export function createSubmitDeliverableTool(input: {
  backendUrl: string;
  backendAuthToken: string | null;
  issueId: string;
  runId: string;
}): Tool {
  return {
    name: "submit_deliverable",
    description:
      "Submit your structured deliverable for the current issue step before finishing. " +
      "Put small extractable values in `fields` (e.g. plan summary, MR url/title, review verdict); " +
      "put large artifacts behind `ref` (a doc/MR link), not inline.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Deliverable type, e.g. plan | mr | review.",
        },
        fields: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Structured small fields for the next step to extract.",
        },
        ref: {
          type: "string",
          description: "Pointer to a large artifact (doc/MR link). Optional.",
        },
      },
      required: ["kind", "fields"],
    },
    async execute(args: unknown) {
      const a = args as { kind: string; fields: Record<string, string>; ref?: string };
      const url = `${input.backendUrl}/api/issues/${input.issueId}/deliverables`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (input.backendAuthToken) headers["x-auth-token"] = input.backendAuthToken;
      // R1: only send deliverable content + runId. fromStatus and idempotency
      // are derived server-side from run_origin — the tool is not authoritative.
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: a.kind,
          fields: a.fields,
          ref: a.ref,
          runId: input.runId,
        }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { error?: string };
        return {
          content: `submit_deliverable failed: HTTP ${resp.status} - ${body.error ?? "unknown"}`,
          isError: true,
        };
      }
      return { content: await resp.text() };
    },
  };
}
