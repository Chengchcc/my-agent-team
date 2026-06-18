"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { IssueBoard } from "@/components/IssueBoard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

export const dynamic = "force-dynamic";

export default function IssuesPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [threadId, setThreadId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const { data: meta } = useQuery({
    queryKey: ["issue-meta"],
    queryFn: api.getIssueMeta,
    staleTime: 60_000,
  });

  const { data: issues } = useQuery({
    queryKey: ["issues"],
    queryFn: () => api.listIssues(),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await api.createIssue({
        projectId: projectId.trim(),
        title: title.trim(),
        threadId: threadId.trim(),
      });
      await queryClient.invalidateQueries({ queryKey: ["issues"] });
      setProjectId("");
      setTitle("");
      setThreadId("");
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create issue");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Issues</h1>
        <Button onClick={() => setShowForm(!showForm)} variant="outline" size="sm">
          {showForm ? "Cancel" : "New Issue"}
        </Button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="space-y-3 max-w-md">
          <Input
            type="text"
            placeholder="Project ID"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            required
          />
          <Input
            type="text"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
          <Input
            type="text"
            placeholder="Thread ID"
            value={threadId}
            onChange={(e) => setThreadId(e.target.value)}
            required
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={submitting} size="sm">
            {submitting ? "Creating..." : "Create Issue"}
          </Button>
        </form>
      )}

      <IssueBoard statuses={meta?.statuses ?? []} issues={issues?.issues ?? []} />
    </div>
  );
}
