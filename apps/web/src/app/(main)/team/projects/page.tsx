import { ProjectForm } from "@/components/ProjectForm";
import { ProjectList } from "@/components/ProjectList";
import { ProjectsStats } from "@/components/ProjectsStats";
import { Page, PageBody, PageHeader } from "@/components/page";
import { serverT } from "@/lib/i18n.server";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  // A server page renders outside the shell's client pass, so it asks the
  // cookie itself (the shell cannot help it: its text is not re-rendered).
  const t = await serverT();
  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Team & Projects" }, { label: "Projects" }]}
        title={t("Projects")}
        subtitle={t("Give every project a working context.")}
        action={<ProjectForm />}
      />
      <PageBody>
        <div className="space-y-8">
          <section className="flex flex-wrap items-end justify-between gap-6 rounded-2xl border border-white/6 bg-(--panel) p-6">
            <div className="min-w-0 max-w-2xl">
              <p className="text-[10px] tracking-[1.8px] uppercase text-(--faint)">
                {t("Repository, team, work")}
              </p>
              <h2 className="mt-2 text-xl font-[550] tracking-[-0.5px] text-(--ink)">
                {t("Code, members and goals line up here.")}
              </h2>
              <p className="mt-2 text-xs/relaxed  text-(--mute)">
                {t(
                  "A project keeps its repository metadata and the members attached to it. Registering one clones nothing and grants nothing.",
                )}
              </p>
            </div>
            <ProjectsStats />
          </section>
          <ProjectList />
        </div>
      </PageBody>
    </Page>
  );
}
