import { parseEnv } from "@chengchenccc/config";
import { Page, PageHeader } from "@/components/page";
import { ExecutionTraceView } from "@/components/workflow/ExecutionTraceView";
import { createServerClient, unwrap } from "@/lib/client";

export const dynamic = "force-dynamic";

export default async function ExecutionTracePage({
  params,
}: {
  params: Promise<{ workflowId: string; executionId: string }>;
}) {
  const { workflowId, executionId } = await params;
  const env = parseEnv(process.env);
  const client = createServerClient(env.BACKEND_URL, env.BACKEND_AUTH_TOKEN);
  const trace = await unwrap(client.api["workflow-executions"]({ executionId }).trace.get()).catch(
    () => null,
  );
  if (trace === null) {
    return (
      <Page>
        <PageHeader
          breadcrumb={[
            { label: "Workflows", href: "/workflows" },
            { label: workflowId, href: `/workflows/${workflowId}` },
          ]}
          title="Execution"
          description="This execution does not exist or cannot be read."
        />
      </Page>
    );
  }
  return (
    <ExecutionTraceView
      execution={trace.execution}
      events={trace.events}
      nodeRuns={trace.nodeRuns}
      pendingHuman={trace.pendingHuman}
    />
  );
}
