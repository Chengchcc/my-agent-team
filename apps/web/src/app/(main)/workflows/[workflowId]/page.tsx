import { WorkflowDetail } from "../_components/workflow-detail";

export const dynamic = "force-dynamic";

/** `/workflows/<id>` is the saved overview. With `edit=1` the editor opens on it. A `tab` value
 *  names the overview's tab. */
export default async function AgenticWorkflowDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workflowId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workflowId } = await params;
  const query = await searchParams;
  return (
    <WorkflowDetail
      workflowId={workflowId}
      edit={query.edit === "1"}
      tab={typeof query.tab === "string" ? query.tab : undefined}
    />
  );
}
