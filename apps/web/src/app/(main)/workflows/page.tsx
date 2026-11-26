import { parseEnv } from "@chengchenccc/config";
import { WorkflowList } from "@/components/workflow/WorkflowList";
import { workflowCard } from "@/features/workflow/list-facts";
import { createServerClient, unwrap } from "@/lib/client";

export const dynamic = "force-dynamic";

/** The entry page. Each workflow is read three times on the server: its row, its definition (for
 *  the counts and the trigger) and its runs (for the last one). A read the backend refuses
 *  leaves that part unknown; the card says so instead of guessing. */
export default async function AgenticWorkflowListPage() {
  const env = parseEnv(process.env);
  const client = createServerClient(env.BACKEND_URL, env.BACKEND_AUTH_TOKEN);
  const list = await unwrap(client.api["workflow-definitions"].get()).catch(() => null);
  if (list === null) {
    return <WorkflowList cards={null} />;
  }
  const cards = await Promise.all(
    list.definitions.map(async (row) => {
      const definitionRead = await unwrap(
        client.api["workflow-definitions"]({ workflowId: row.workflowId }).get(),
      ).catch(() => null);
      const runsRead = await unwrap(
        client.api["workflow-executions"].get({ query: { workflowId: row.workflowId } }),
      ).catch(() => null);
      const definition = definitionRead === null ? null : definitionRead.definition;
      const executions = runsRead === null ? [] : runsRead.executions;
      return workflowCard(row, definition, executions);
    }),
  );
  return <WorkflowList cards={cards} />;
}
