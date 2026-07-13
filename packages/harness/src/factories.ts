import type { ChatModel, Tool } from "@my-agent-team/core";
import type { Plugin } from "@my-agent-team/framework";

export interface ModelFactory {
  create(modelName: string): ChatModel;
}

export interface ToolFactory {
  create(cwd: string): Tool[];
}

export interface PluginFactory {
  create(cwd: string): Plugin[];
}
