import { parseEnv } from "@my-agent-team/config";
import { ConversationCanvas } from "@/components/ConversationCanvas";
import type { ConversationSnapshot } from "@/lib/api";

const _env = parseEnv(process.env);

// Server-side fetch of conversation snapshot for first-paint bootstrap.
async function fetchConversation(conversationId: string): Promise<ConversationSnapshot | null> {
  try {
    const res = await fetch(`${_env.BACKEND_URL}/api/conversations/${conversationId}`, {
      headers: { "x-auth-token": _env.BACKEND_AUTH_TOKEN },
    });
    if (!res.ok) return null;
    return (await res.json()) as ConversationSnapshot;
  } catch {
    return null;
  }
}

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const snapshot = await fetchConversation(id);

  return <ConversationCanvas conversationId={id} snapshot={snapshot} />;
}
