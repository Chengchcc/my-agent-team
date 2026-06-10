export type Role = "user" | "assistant" | "system" | "internal";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  /** If "internal", the model output following this tool result
   *  is labeled "internal" instead of "assistant". */
  role?: "internal";
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: string | ContentBlock[];
}
