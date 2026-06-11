import { AnthropicChatModel } from "@my-agent-team/adapter-anthropic";
import type { Message } from "@my-agent-team/core";
import { collectStream } from "@my-agent-team/core";

const TITLE_SYSTEM =
  "你是一个会话标题生成器。阅读用户与助手的前几轮对话，输出一个不超过12个字的简短中文标题，" +
  "概括会话主题。只输出标题本身，不要引号、标点结尾或任何解释。";

/** Extract text from Message content (string or ContentBlock[]). */
function extractMsgText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("");
  }
  return "";
}

/** Extract first N turns of user/assistant text for title generation context. */
export function buildTitleContext(msgs: Message[], maxTurns = 4): string {
  return msgs
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(0, maxTurns * 2) // each turn = user + assistant
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${extractMsgText(m.content)}`)
    .filter((line) => line.length > 3)
    .join("\n");
}

export function sanitizeTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["'「『]|["'」』]$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 60);
}

export async function generateTitle(
  cfg: { apiKey?: string; model?: string; baseUrl?: string },
  context: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!context || context.length < 4) return null;
  const chat = new AnthropicChatModel({
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    maxTokens: 64,
  });
  const { blocks } = await collectStream(
    chat.stream(
      [
        { role: "system", content: TITLE_SYSTEM },
        { role: "user", content: context },
      ],
      { signal },
    ),
  );
  const raw = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  const title = sanitizeTitle(raw);
  return title.length > 0 ? title : null;
}
