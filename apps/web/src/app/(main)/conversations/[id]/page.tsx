import { parseEnv } from "@my-agent-team/config";
import { ConversationCanvas } from "@/components/ConversationCanvas";
import type { ConversationSnapshot } from "@/lib/api";
import { createServerClient, unwrap } from "@/lib/client";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let snapshot: ConversationSnapshot | null = null;
  try {
    const env = parseEnv(process.env);
    const client = createServerClient(env.BACKEND_URL, env.BACKEND_AUTH_TOKEN);
    snapshot = await unwrap<ConversationSnapshot>(client.api.conversations({ id }).get());
  } catch {
    // Graceful — Canvas handles missing snapshot
  }
  return <ConversationCanvas conversationId={id} snapshot={snapshot} />;
}
