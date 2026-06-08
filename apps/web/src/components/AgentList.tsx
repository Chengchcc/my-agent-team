"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function AgentList() {
  const { data: agents, isLoading } = useQuery({
    queryKey: ["agents"],
    queryFn: api.listAgents,
  });

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-24" />
            </CardHeader>
          </Card>
        ))}
      </div>
    );
  }

  const active = (agents ?? []).filter((a) => !a.archivedAt);

  if (active.length === 0) {
    return (
      <p className="text-muted-foreground py-12 text-center">
        No agents yet. Create your first agent to get started.
      </p>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {active.map((agent) => (
        <Link key={agent.id} href={`/agents/${agent.id}`}>
          <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {agent.name}
              </CardTitle>
              <CardDescription>
                {agent.modelProvider} / {agent.modelName}
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
      ))}
    </div>
  );
}
