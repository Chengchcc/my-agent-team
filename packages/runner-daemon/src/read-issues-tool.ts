import type { Tool } from "@my-agent-team/core";

/**
 * M19 Fix 8: Create a `read_issues` tool for issue runs.
 * Provides two read-only actions: get_issue (single) and list_issues (per project).
 * Calls the backend's GET /api/issues/:id and GET /api/issues?projectId= endpoints.
 * Never exposes mutation — status changes are the orchestrator's sole domain.
 */
export function createReadIssuesTool(input: {
  backendUrl: string;
  backendAuthToken: string | null;
  issueId: string;
  projectId?: string;
}): Tool {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (input.backendAuthToken) headers["x-auth-token"] = input.backendAuthToken;

  return {
    name: "read_issues",
    description:
      "Read-only access to issues in your project. Use get_issue(id?) to fetch the current issue's full details, " +
      "or list_issues to list all issues in the same project. You CANNOT change issue status — " +
      "status is managed by the orchestrator and human review.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get_issue", "list_issues"],
          description:
            "get_issue: fetch the current issue (id optional, defaults to this run's issue). " +
            "list_issues: list all issues in the current project.",
        },
        id: {
          type: "string",
          description: "Issue ID to fetch (optional for get_issue, defaults to current issue).",
        },
      },
      required: ["action"],
    },
    async execute(args: unknown) {
      const a = args as { action: "get_issue" | "list_issues"; id?: string };
      try {
        if (a.action === "get_issue") {
          const id = a.id ?? input.issueId;
          const url = `${input.backendUrl}/api/issues/${id}`;
          const resp = await fetch(url, { headers });
          if (!resp.ok) {
            const body = (await resp.json().catch(() => ({}))) as { error?: string };
            return {
              content: `get_issue failed: HTTP ${resp.status} - ${body.error ?? "unknown"}`,
              isError: true,
            };
          }
          const data = await resp.json();
          return { content: JSON.stringify(data) };
        }
        // list_issues — filter by projectId if available
        const url = input.projectId
          ? `${input.backendUrl}/api/issues?projectId=${input.projectId}`
          : `${input.backendUrl}/api/issues`;
        const resp = await fetch(url, { headers });
        if (!resp.ok) {
          const body = (await resp.json().catch(() => ({}))) as { error?: string };
          return {
            content: `list_issues failed: HTTP ${resp.status} - ${body.error ?? "unknown"}`,
            isError: true,
          };
        }
        const data = await resp.json();
        return { content: JSON.stringify(data) };
      } catch (err) {
        return {
          content: `read_issues failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}
