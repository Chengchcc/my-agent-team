"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { IssueRow } from "@/lib/api";
import { api } from "@/lib/api";
import { IssueStatusBadge } from "./IssueStatusBadge";

export function IssueCard({
  issue,
  onDecision,
}: {
  issue: IssueRow;
  onDecision?: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleApprove() {
    setLoading(true);
    try {
      await api.reviewDecision(issue.issueId, { decision: "approve" });
      onDecision?.();
    } catch (err) {
      toast.error("Approve failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleReject() {
    if (!note.trim()) return;
    setLoading(true);
    try {
      await api.reviewDecision(issue.issueId, { decision: "reject", note: note.trim() });
      setRejecting(false);
      setNote("");
      onDecision?.();
    } catch (err) {
      toast.error("Reject failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{issue.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <IssueStatusBadge status={issue.status} />

        {issue.status === "in_review" && (
          <div className="mt-2 space-y-2">
            {!rejecting ? (
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-7"
                  onClick={handleApprove}
                  disabled={loading}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-7 text-destructive"
                  onClick={() => setRejecting(true)}
                  disabled={loading}
                >
                  Reject
                </Button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Input
                  placeholder="Rejection reason"
                  className="h-7 text-xs"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleReject();
                    if (e.key === "Escape") {
                      setRejecting(false);
                      setNote("");
                    }
                  }}
                />
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    className="text-xs h-7"
                    onClick={handleReject}
                    disabled={loading || !note.trim()}
                  >
                    Confirm Reject
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs h-7"
                    onClick={() => {
                      setRejecting(false);
                      setNote("");
                    }}
                    disabled={loading}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
