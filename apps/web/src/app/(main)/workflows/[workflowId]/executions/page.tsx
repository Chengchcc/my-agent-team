import { WorkflowDetail } from "../../_components/workflow-detail";

export const dynamic = "force-dynamic";

/** The runs of one workflow keep their address. They are the saved overview's Executions tab. */
export default async function ExecutionsPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;
  return <WorkflowDetail workflowId={workflowId} tab="executions" edit={false} />;
}
