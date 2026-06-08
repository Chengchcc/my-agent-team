import { ThreadWorkspace } from "@/components/ThreadWorkspace";

// Server-side helper to fetch current run directly from backend
async function fetchCurrentRun(
  threadId: string,
): Promise<{ runId: string; status: string } | null> {
  const BACKEND_URL = process.env.BACKEND_URL;
  const BACKEND_TOKEN = process.env.BACKEND_TOKEN;
  if (!BACKEND_URL || !BACKEND_TOKEN) return null;

  try {
    const res = await fetch(
      `${BACKEND_URL}/api/threads/${threadId}/current-run`,
      { headers: { "x-auth-token": BACKEND_TOKEN } },
    );
    if (!res.ok) return null;
    return (await res.json()) as { runId: string; status: string } | null;
  } catch {
    return null;
  }
}

export default async function ThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const currentRun = await fetchCurrentRun(id);

  return <ThreadWorkspace threadId={id} initialCurrentRun={currentRun} />;
}
