import { AgentForm } from "@/components/AgentForm";
import { AgentList } from "@/components/AgentList";

export default function AgentsPage() {
  return (
    <div className="h-full bg-[var(--canvas)]">
      {/* Top bar */}
      <div className="border-b border-[var(--hairline)]">
        <div className="container mx-auto px-8 py-5 flex items-center justify-between">
          <h1
            className="text-lg font-normal text-[var(--ink-strong)] font-[family-name:var(--font-sans)]"
            style={{ letterSpacing: "-0.9px" }}
          >
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
