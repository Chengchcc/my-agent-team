"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOutIcon, MoreHorizontalIcon, Trash2Icon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { api } from "@/lib/api";

function NavContent() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const router = useRouter();
  const queryClient = useQueryClient();

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

  const deleteConversation = useMutation({
    mutationFn: (id: string) => api.deleteConversation(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["conversations", selectedAgentId] });
      if (pathname === `/conversations/${id}`) {
        router.push(selectedAgentId ? `/agents/${selectedAgentId}` : "/");
      }
    },
    onError: (err) => {
      toast.error("Failed to delete conversation", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    },
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
                      {
                        memberId: selectedAgentId,
                        kind: "agent",
                        agentId: selectedAgentId,
                        displayName: agent?.name,
                      },
                      {
                        memberId: humanId,
                        kind: "human",
                        userRef: "__legacy__",
                        displayName: "User",
                      },
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
              {(conversations ?? []).map((conv) => {
                const title = conv.title ?? `Conversation ${conv.conversationId.slice(0, 8)}`;
                return (
                  <SidebarMenuItem key={conv.conversationId}>
                    <SidebarMenuButton
                      isActive={pathname === `/conversations/${conv.conversationId}`}
                      tooltip={title}
                      onClick={() => {
                        closeMobile();
                        router.push(`/conversations/${conv.conversationId}`);
                      }}
                    >
                      <span className="truncate">{title}</span>
                    </SidebarMenuButton>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<SidebarMenuAction showOnHover aria-label="Conversation actions" />}
                      >
                        <MoreHorizontalIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="right" align="start" className="w-44">
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={deleteConversation.isPending}
                          onClick={() => deleteConversation.mutate(conv.conversationId)}
                        >
                          <Trash2Icon />
                          Delete conversation
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SidebarMenuItem>
                );
              })}
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

function NavFooter() {
  const router = useRouter();

  async function signOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger render={<SidebarMenuButton />}>
              <LogOutIcon />
              <span className="truncate group-data-[collapsible=icon]:hidden">Account</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-48">
              <DropdownMenuLabel>Signed in</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={signOut}>
                <LogOutIcon />
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}

export function NavRail() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center justify-between gap-2 px-2 py-1">
          <span className="text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            Observatory
          </span>
          <SidebarTrigger className="hidden md:flex" />
        </div>
      </SidebarHeader>
      <NavContent />
      <NavFooter />
    </Sidebar>
  );
}
