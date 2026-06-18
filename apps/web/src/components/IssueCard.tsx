import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { IssueRow } from "@/lib/api";
import { IssueStatusBadge } from "./IssueStatusBadge";

export function IssueCard({ issue }: { issue: IssueRow }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{issue.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <IssueStatusBadge status={issue.status} />
      </CardContent>
    </Card>
  );
}
