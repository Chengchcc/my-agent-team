import { AgentList } from "@/components/AgentList";
import { AgentForm } from "@/components/AgentForm";

export default function AgentsPage() {
  return (
    <div className="min-h-screen bg-[var(--cream)]">
      {/* Top bar */}
      <div className="border-b border-[var(--border-color)]">
        <div className="container mx-auto px-8 py-6 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <p className="font-[family-name:var(--font-mono)] text-[10px] tracking-[0.2em] uppercase text-[var(--warm-gray-dark)]">
              Observatory
            </p>
            <div className="w-px h-4 bg-[var(--border-color)]" />
            <h1 className="font-[family-name:var(--font-heading)] text-xl font-medium text-[var(--charcoal)]">
              Agents
            </h1>
          </div>
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
