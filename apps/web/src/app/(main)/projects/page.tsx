import { ProjectForm } from "@/components/ProjectForm";
import { ProjectList } from "@/components/ProjectList";

export const dynamic = "force-dynamic";

export default function ProjectsPage() {
  return (
    <div className="h-full bg-[var(--canvas)]">
      <div className="border-b border-[var(--hairline)]">
        <div className="container mx-auto px-8 py-5 flex items-center justify-between">
          <h1 className="text-lg font-normal text-[var(--ink-strong)] font-[family-name:var(--font-sans)]">
            Projects
          </h1>
          <ProjectForm />
        </div>
      </div>
      <div className="container mx-auto px-8 py-10">
        <ProjectList />
      </div>
    </div>
  );
}
