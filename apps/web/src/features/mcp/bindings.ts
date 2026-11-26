/** Who binds a connection, as the member's own setting says: nothing, bound and enabled, or
 *  bound but switched off. The three are kept apart so "disabled" is never saved as "removed". */
export type Binding = "none" | "bound" | "disabled";

export interface Member {
  id: string;
  mcpServers?: Array<{ serverId: string; enabled: boolean }>;
}

export function bindingOf(member: Member, serverId: string): Binding {
  const entry = member.mcpServers?.find((m) => m.serverId === serverId);
  if (entry === undefined) return "none";
  if (entry.enabled) return "bound";
  return "disabled";
}

export type BindingChange = "add" | "remove" | "keep";

/** What saving the box does. A disabled entry left unchecked is left alone. */
export function bindingChange(before: Binding, checked: boolean): BindingChange {
  if (checked) {
    return before === "bound" ? "keep" : "add";
  }
  return before === "bound" ? "remove" : "keep";
}

/** The bodies to send: only the members whose box changed, each with its whole (rewritten)
 *  binding list for this server. Other servers in the list are carried over untouched. */
export function bindChanges(
  members: readonly Member[],
  serverId: string,
  checked: Readonly<Record<string, boolean>>,
): Array<{ agentId: string; mcpServers: Array<{ serverId: string; enabled: boolean }> }> {
  const changes: ReturnType<typeof bindChanges> = [];
  for (const member of members) {
    const change = bindingChange(bindingOf(member, serverId), checked[member.id] === true);
    if (change === "keep") continue;
    const others = (member.mcpServers ?? []).filter((m) => m.serverId !== serverId);
    if (change === "add") others.push({ serverId, enabled: true });
    changes.push({ agentId: member.id, mcpServers: others });
  }
  return changes;
}
