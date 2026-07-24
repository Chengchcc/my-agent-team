import type { Plugin } from "@my-agent-team/framework";

/** Extract hooks from a Plugin's hooks object, preserving the framework PluginHooks shape. */
type PluginHooks = NonNullable<Plugin["hooks"]>;

/**
 * Helper: cast a Plugin's hooks to AgentExtension hooks.
 * During migration, PluginHooks and AgentHooks are structurally similar enough.
 */
export function asAgentHooks(
  hooks: PluginHooks,
): NonNullable<ReturnType<NonNullable<Capability["extendAgent"]>>["hooks"]> {
  return hooks as unknown as NonNullable<
    ReturnType<NonNullable<Capability["extendAgent"]>>["hooks"]
  >;
}
