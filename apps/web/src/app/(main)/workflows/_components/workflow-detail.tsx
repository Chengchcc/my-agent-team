import { parseEnv } from "@chengchenccc/config";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Page, PageHeader } from "@/components/page";
import { buttonVariants } from "@/components/ui/button";
import { AgenticWorkflowEditor } from "@/components/workflow/AgenticWorkflowEditor";
import { WorkflowOverview } from "@/components/workflow/WorkflowOverview";
import { overviewTabOf } from "@/features/workflow/overview-tab";
import { definitionOf } from "@/features/workflow/proposal-draft";
import { createServerClient, unwrap } from "@/lib/client";
import { t } from "@/lib/i18n";

/** The saved definition as the server read it, and the list's row of the same workflow. Either is
 *  null when the backend refused to give it. */
async function readWorkflow(workflowId: string) {
  const env = parseEnv(process.env);
  const client = createServerClient(env.BACKEND_URL, env.BACKEND_AUTH_TOKEN);
  const [definitionRead, list] = await Promise.all([
    unwrap(client.api["workflow-definitions"]({ workflowId }).get()).catch(() => null),
    unwrap(client.api["workflow-definitions"].get()).catch(() => null),
  ]);
  const row =
    list === null ? undefined : list.definitions.find((entry) => entry.workflowId === workflowId);
  return {
    raw: definitionRead === null ? null : definitionRead.definition,
    row: row ?? null,
  };
}

/** One workflow's address. `edit` opens the editor; otherwise the page is the saved overview,
 *  on the tab the address names. The server reads the definition once either way, so the editor
 *  opens on what is saved, never on a guess. */
export async function WorkflowDetail({
  workflowId,
  tab,
  edit,
}: {
  workflowId: string;
  tab: string | undefined;
  edit: boolean;
}) {
  const { raw, row } = await readWorkflow(workflowId);
  if (raw === null) {
    return (
      <Page>
        <PageHeader
          kicker={t("{id} · Workflow", { id: workflowId })}
          title="Workflow"
          description="This workflow does not exist or cannot be read."
          actions={
            <Link href="/workflows" className={buttonVariants({ variant: "outline", size: "sm" })}>
              <ArrowLeft />
              {t("All workflows")}
            </Link>
          }
        />
      </Page>
    );
  }
  if (edit) {
    return <AgenticWorkflowEditor workflowId={workflowId} initial={definitionOf(raw)} />;
  }
  const missing = { workflowId, updatedAt: 0 };
  return (
    <WorkflowOverview
      workflowId={workflowId}
      raw={raw}
      row={row ?? missing}
      initialTab={overviewTabOf(tab)}
    />
  );
}
