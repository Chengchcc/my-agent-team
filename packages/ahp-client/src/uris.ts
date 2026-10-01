/** The URI rules for AHP channels: a protocol-level fact, shared by surfaces and the host.
 *
 *
 *  The root literal, the session and chat prefixes, and the product-id to URI translation
 *  live here only. A product id cannot contain a slash: the URI must resolve back to one id. */
import type { URI } from "@microsoft/agent-host-protocol";

export const AHP_ROOT_URI = "ahp-root://" as URI;
export const AHP_CHAT_PREFIX = "ahp-chat:/";
export const AHP_SESSION_PREFIX = "ahp-session:/";

export function chatUri(conversationId: string): URI {
  return `${AHP_CHAT_PREFIX}${conversationId}` as URI;
}

export function sessionUri(conversationId: string): URI {
  return `${AHP_SESSION_PREFIX}${conversationId}` as URI;
}

/** Returns the id when the prefix matches and the id is non-empty and slash-free. */
export function conversationIdFrom(uri: URI, prefix: string): string | undefined {
  if (!uri.startsWith(prefix)) return undefined;
  const id = uri.slice(prefix.length);
  return id === "" || id.includes("/") ? undefined : id;
}
