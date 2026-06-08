import { AgentList } from "@/components/AgentList";
import { AgentForm } from "@/components/AgentForm";

export default function AgentsPage() {
  return (
    <div className="container mx-auto py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Agents</h1>
        <AgentForm />
      </div>
      <AgentList />
    </div>
  );
}
