"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ThreadList } from "@/components/ThreadList";
import { IdentityPanel } from "@/components/IdentityPanel";

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: agent, isLoading } = useQuery({
    queryKey: ["agent", id],
    queryFn: () => api.getAgent(id),
  });

  if (isLoading) {
    return (
      <div className="container mx-auto py-8 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-5 w-48" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="container mx-auto py-8">Agent not found</div>
    );
  }

  return (
    <div className="container mx-auto py-8 space-y-6">
      <div className="flex items-center gap-4">
        <Link
          href="/agents"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Agents
        </Link>
        <h1 className="text-2xl font-bold">{agent.name}</h1>
        <Badge variant="outline">
          {agent.modelProvider} / {agent.modelName}
        </Badge>
      </div>

      <Tabs defaultValue="threads">
        <TabsList>
          <TabsTrigger value="threads">Threads</TabsTrigger>
          <TabsTrigger value="identity">Persona & Memory</TabsTrigger>
        </TabsList>
        <TabsContent value="threads" className="mt-4">
          <ThreadList agentId={id} />
        </TabsContent>
        <TabsContent value="identity" className="mt-4">
          <IdentityPanel agentId={id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
