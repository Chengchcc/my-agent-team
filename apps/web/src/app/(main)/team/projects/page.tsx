import { ProjectForm } from "@/components/ProjectForm";
import { ProjectList } from "@/components/ProjectList";
import { Page, PageBody, PageHeader } from "@/components/page";
import { InfoBanner } from "@/components/ui/polish";
import { serverT } from "@/lib/i18n.server";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  // A server page renders outside the shell's client pass, so it asks the
  // cookie itself (the shell cannot help it: its text is not re-rendered).
  const t = await serverT();
  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Team", href: "/team" },
          { label: "Projects", href: "/team/projects" },
        ]}
        title={t("Projects")}
        description={t("Repositories and automation targets.")}
        action={<ProjectForm />}
      />
      <PageBody>
        <div className="space-y-6">
          <InfoBanner
            id="ib:projects-help"
            title={t("How this page works")}
            body={t(
              "Projects materialize a repo worktree per agent. Create a project, then attach it to agents from the project's Agents tab so runs operate against its mirror.",
            )}
          />
          <ProjectList />
        </div>
      </PageBody>
    </Page>
  );
}
