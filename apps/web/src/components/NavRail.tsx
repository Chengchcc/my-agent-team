"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/api";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

function NavContent() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const router = useRouter();

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: api.listAgents,
    staleTime: 30_000,
  });

  const activeAgents = (agents ?? []).filter((a) => !a.archivedAt);
  const agentIdMatch = pathname.match(/\/agents\/([^/]+)/);
  const selectedAgentId = agentIdMatch?.[1] ?? null;

  const { data: conversations } = useQuery({
    queryKey: ["conversations", selectedAgentId],
    queryFn: () => api.listConversations(selectedAgentId!),
    enabled: !!selectedAgentId,
    staleTime: 10_000,
  });

  function closeMobile() {
    setOpenMobile(false);
  }

  return (
    <SidebarContent>
      {/* Workspace — Agents */}
      <SidebarGroup>
        <SidebarGroupLabel>Workspace</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {activeAgents.length === 0 && (
              <p className="text-xs text-muted-foreground px-2">No agents yet</p>
            )}
            {activeAgents.map((agent) => (
              <SidebarMenuItem key={agent.id}>
                <SidebarMenuButton
                  isActive={pathname.startsWith(`/agents/${agent.id}`)}
                  tooltip={agent.name}
                  onClick={() => {
                    closeMobile();
                    router.push(`/agents/${agent.id}`);
                  }}
                >
                  <span className="truncate">{agent.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {/* Conversations (when agent selected) */}
      {selectedAgentId && (
        <SidebarGroup>
          <SidebarGroupLabel>
            Conversations
            <button
              type="button"
              onClick={async () => {
                try {
                  const agent = activeAgents.find((a) => a.id === selectedAgentId);
                  const humanId = `human-${crypto.randomUUID().slice(0, 8)}`;
                  const conv = await api.createConversation({
                    members: [
                      { memberId: selectedAgentId, kind: "agent", agentId: selectedAgentId, displayName: agent?.name },
                      { memberId: humanId, kind: "human", userRef: "__legacy__", displayName: "User" },
                    ],
                  });
                  closeMobile();
                  router.push(`/conversations/${conv.conversationId}`);
                } catch (err) {
                  toast.error("Failed to create conversation", {
                    description: err instanceof Error ? err.message : "Unknown error",
                  });
                }
              }}
              className="ml-auto text-primary hover:text-primary/80 text-xs"
              aria-label="New conversation"
            >
              +
            </button>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {(conversations ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground px-2">No conversations yet</p>
              )}
              {(conversations ?? []).map((conv) => (
                <SidebarMenuItem key={conv.conversationId}>
                  <SidebarMenuButton
                    isActive={pathname === `/conversations/${conv.conversationId}`}
                    tooltip={conv.title ?? `Conversation ${conv.conversationId.slice(0, 6)}`}
                    onClick={() => {
                      closeMobile();
                      router.push(`/conversations/${conv.conversationId}`);
                    }}
                  >
                    <span className="truncate">{conv.title ?? `Conversation ${conv.conversationId.slice(0, 8)}`}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      )}

      {/* Issues + Projects */}
      <SidebarGroup>
        <SidebarGroupLabel>Navigate</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/issues")}
                tooltip="Issues"
                onClick={() => {
                  closeMobile();
                  router.push("/issues");
                }}
              >
                Issues
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/projects")}
                tooltip="Projects"
                onClick={() => {
                  closeMobile();
                  router.push("/projects");
                }}
              >
                Projects
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {/* Operations */}
      <SidebarGroup>
        <SidebarGroupLabel>Operations</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/ops")}
                tooltip="Operations"
                onClick={() => {
                  closeMobile();
                  router.push("/ops");
                }}
              >
                Observability
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}

export function NavRail() {
  return (
    <Sidebar collapsible="icon">
      <NavContent />
    </Sidebar>
  );
}
