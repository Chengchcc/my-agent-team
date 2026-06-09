import { ConversationCanvas } from "@/components/ConversationCanvas";
import type { ConversationSnapshot } from "@/lib/api";

// Server-side fetch of conversation snapshot for first-paint bootstrap.
async function fetchConversation(conversationId: string): Promise<ConversationSnapshot | null> {
  const BACKEND_URL = process.env.BACKEND_URL;
  const BACKEND_TOKEN = process.env.BACKEND_TOKEN;
  if (!BACKEND_URL || !BACKEND_TOKEN) return null;

  try {
    const res = await fetch(`${BACKEND_URL}/api/conversations/${conversationId}`, {
      headers: { "x-auth-token": BACKEND_TOKEN },
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
