"use client";

import { createContext, useContext } from "react";
import type { ArtifactMeta } from "@/lib/api";

/** Target shown in the Chat page's right-hand Antigravity-style preview pane. */
export type ChatInspectorTarget =
  | { kind: "artifact"; artifact: ArtifactMeta }
  | { kind: "requirement"; requirementId: string };

export interface ChatInspectorController {
  active: ChatInspectorTarget | null;
  openArtifact: (artifact: ArtifactMeta) => void;
  openRequirement: (requirementId: string) => void;
  closePreview: () => void;
}

export const ChatInspectorContext = createContext<ChatInspectorController | null>(null);

/** Present inside `/chat/[conversationId]` so inline Markdown chips/cards and timeline
 *  attachments open directly in the right-hand split pane instead of covering the chat
 *  or navigating away. Returns `null` on standalone pages (where components fall back
 *  to their own modal/sheet). */
export function useChatInspector(): ChatInspectorController | null {
  return useContext(ChatInspectorContext);
}
