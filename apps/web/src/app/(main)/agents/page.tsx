import { AgentList } from "@/components/AgentList";
import { AgentForm } from "@/components/AgentForm";

export default function AgentsPage() {
  return (
    <div className="h-full bg-[var(--cream)]">
      {/* Top bar */}
      <div className="border-b border-[var(--border-color)]">
        <div className="container mx-auto px-8 py-5 flex items-center justify-between">
          <h1 className="font-[family-name:var(--font-heading)] text-lg font-medium text-[var(--charcoal)]">
            Agents
          </h1>
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
