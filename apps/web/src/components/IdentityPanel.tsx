"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";

function MarkdownSection({
  title,
  content,
}: {
  title: string;
  content: string | null;
}) {
  if (content === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertDescription>Not yet configured</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <pre className="whitespace-pre-wrap font-sans text-sm">
          {content}
        </pre>
      </CardContent>
    </Card>
  );
}

export function IdentityPanel({ agentId }: { agentId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["identity", agentId],
    queryFn: () => api.getIdentity(agentId),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (!data) {
    return <p className="text-muted-foreground">Failed to load identity</p>;
  }

  return (
    <div className="space-y-4">
      <MarkdownSection title="SOUL" content={data.soul} />
      <MarkdownSection title="USER" content={data.user} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Memory ({data.memories.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.memories.length === 0 ? (
            <Alert>
              <AlertDescription>No memories recorded</AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-3">
              {data.memories.map((mem, i) => (
                <div key={i}>
                  <p className="text-xs text-muted-foreground mb-1">
                    {mem.date}
                  </p>
                  <pre className="whitespace-pre-wrap font-sans text-sm">
                    {mem.content}
                  </pre>
                  {i < data.memories.length - 1 && (
                    <Separator className="mt-3" />
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
