import { AgentForm } from "@/components/AgentForm";
import { AgentList } from "@/components/AgentList";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";

export default function AgentsPage() {
  return (
    <div className="h-full bg-[var(--canvas)]">
      {/* Top bar */}
      <div className="border-b border-[var(--hairline)]">
        <div className="container mx-auto px-8 py-5 flex items-center justify-between">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Agents</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <AgentForm />
        </div>
      </div>

      {/* Content */}
      <div className="container mx-auto px-8 py-10">
        <AgentList />
      </div>
    </div>
  );
}
