"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ActivityIcon,
  ArchiveIcon,
  BookOpenIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderKanbanIcon,
  LogOutIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  NetworkIcon,
  Package,
  PlugIcon,
  PlusIcon,
  RadioIcon,
  RefreshCwIcon,
  ScaleIcon,
  SettingsIcon,
  TerminalIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { useAgentList } from "@/features/agents/hooks";
import {
  conversationKeys,
  useAllConversations,
  useCreateConversation,
  useDeleteConversation,
} from "@/features/conversations/hooks";
import { useCurrentUser } from "@/features/identity/hooks";
import { useProjects } from "@/features/requirements/hooks";
import { waitingGatesQuery } from "@/features/workflow/queries";
import type { AgentRow } from "@/lib/api";
import { conversationDisplayName } from "@/lib/conversation-title";
import { chooseLocale, currentLocale, localeOptions, t } from "@/lib/i18n";
import { isUnread, markRead } from "@/lib/read-seq";

function NavContent() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const router = useRouter();
  const queryClient = useQueryClient();

  // Quick-create agent resolution: default → first enabled (never a dead id).
  const { data: agents } = useAgentList() as { data?: AgentRow[] };
  const { data: conversations, isLoading: conversationsLoading } = useAllConversations();
  // Loop/Cron conversations belong in Work, not Chat — exclude them from the rail.
  const chatConversations = (conversations ?? []).filter(
    (c) => "origin" in c && c.origin !== "loop" && c.origin !== "cron" && c.origin !== "workflow",
  );
  const deleteConversation = useDeleteConversation();
  // ADR 0076: a conversation may be BOUND to a project — then its dispatch
  // guard, its brief and its terminal all use that project. Optional on
  // purpose: ad-hoc rooms (questions, wiki upkeep) have no project.
  const [newOpen, setNewOpen] = useState(false);
  const [newProject, setNewProject] = useState("");
  /** "front" = the default front agent; a worker id = a direct line. */
  const [newAgent, setNewAgent] = useState("front");
  const { data: projectRows } = useProjects();
  const projects =
    (projectRows as { projects?: Array<{ projectId: string; name: string }> } | undefined)
      ?.projects ?? [];
  const { confirm, dialog: confirmDialog } = useConfirm();

  // U4: badge the Workflows nav when any execution waits for a human.
  const { data: waitingGates } = useQuery(waitingGatesQuery());
  const createConversation = useCreateConversation();
  const chatScrollRef = useRef<HTMLDivElement>(null);
  // ADR 0074 S0: team-member rooms (dispatch origin) fold UNDER the room that
  // dispatched them — one level, collapsed by default. The rail stays a
  // person-organized surface; the team's work is one click deeper.
  const roots = chatConversations.filter((c) => !c.parentConversationId);
  const childrenOf = new Map<string, typeof chatConversations>();
  for (const c of chatConversations) {
    if (!c.parentConversationId) continue;
    const bucket = childrenOf.get(c.parentConversationId) ?? [];
    bucket.push(c);
    childrenOf.set(c.parentConversationId, bucket);
  }
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const railItems = roots.flatMap((conv) => {
    const kids = childrenOf.get(conv.conversationId) ?? [];
    if (kids.length === 0 || !expanded.has(conv.conversationId)) {
      return [{ conv, childCount: kids.length }];
    }
    return [
      { conv, childCount: kids.length },
      ...kids.map((child) => ({ conv: child, childCount: 0 })),
    ];
  });
  const virtualizer = useVirtualizer({
    count: railItems.length,
    getScrollElement: () => chatScrollRef.current,
    estimateSize: () => 36,
    overscan: 5,
  });

  function closeMobile() {
    setOpenMobile(false);
  }

  function makeConversation(projectId?: string, agentIdChoice?: string) {
    // Quick-create targets the default agent, falling back to the first
    // enabled one — never a hardcoded dead agent id. An explicit choice wins;
    // choosing a worker opens a DIRECT LINE (ADR 0049 amendment), which the
    // backend only accepts with `direct: true`.
    const agent =
      (agentIdChoice ? agents?.find((a) => a.id === agentIdChoice) : undefined) ??
      agents?.find((a) => a.id === "default" && a.enabled !== false) ??
      agents?.find((a) => a.enabled !== false) ??
      agents?.[agents.length - 1];
    const agentId = agent?.id ?? "default";
    const direct = agent?.role === "worker";
    createConversation.mutate(
      {
        agentId,
        ...(projectId ? { projectId } : {}),
        ...(direct ? { direct: true } : {}),
      },
      {
        onSuccess: (conv) => {
          queryClient.invalidateQueries({ queryKey: conversationKeys.all });
          closeMobile();
          router.push(`/chat/${conv.conversationId}`);
        },
        onError: (err) => {
          toast.error("Failed to create conversation", {
            description: err instanceof Error ? err.message : "Unknown error",
          });
        },
      },
    );
  }

  return (
    <SidebarContent>
      {/* Work */}
      <SidebarGroup>
        <SidebarGroupLabel>{t("Work")}</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname === "/today"}
                tooltip={t("Today")}
                onClick={() => {
                  closeMobile();
                  router.push("/today");
                }}
              >
                <RefreshCwIcon />
                <span className="truncate">{t("Today")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/chat")}
                tooltip={t("Work sessions")}
                onClick={() => {
                  closeMobile();
                  router.push("/chat");
                }}
              >
                <MessageSquareIcon />
                <span className="truncate">{t("Work sessions")}</span>
                {roots.length > 0 && (
                  <span
                    data-testid="work-sessions-count"
                    className="ml-auto rounded-[4px] bg-white/2 px-1.5 font-mono text-[10px] text-(--faint)"
                  >
                    {roots.length}
                  </span>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/requirements")}
                tooltip={t("Requirements")}
                onClick={() => {
                  closeMobile();
                  router.push("/requirements");
                }}
              >
                <FolderKanbanIcon />
                <span className="truncate">{t("Requirements")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/workflows")}
                tooltip={t("Workflows")}
                onClick={() => {
                  closeMobile();
                  router.push("/workflows");
                }}
              >
                <NetworkIcon />
                <span className="truncate">{t("Workflows")}</span>
                {(waitingGates ?? 0) > 0 && (
                  <span
                    data-testid="waiting-gates-badge"
                    className="ml-auto flex size-4 shrink-0 items-center justify-center rounded-full bg-(--warn) text-[9px] font-semibold text-(--canvas)"
                    title={`${waitingGates ?? 0} workflow${(waitingGates ?? 0) > 1 ? "s" : ""} waiting for your decision`}
                  >
                    {waitingGates ?? 0}
                  </span>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/artifacts")}
                tooltip={t("Artifacts")}
                onClick={() => {
                  closeMobile();
                  router.push("/artifacts");
                }}
              >
                <ArchiveIcon />
                <span className="truncate">{t("Artifacts")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/coding")}
                tooltip={t("Coding")}
                onClick={() => {
                  closeMobile();
                  router.push("/coding");
                }}
              >
                <TerminalIcon />
                <span className="truncate">{t("Coding")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {/* Chat */}
      <SidebarGroup>
        <SidebarGroupLabel>
          {t("Recent conversations")}
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={createConversation.isPending}
            onClick={() => {
              setNewProject("");
              setNewOpen(true);
            }}
            className="ml-auto text-primary hover:text-primary/80"
            aria-label="New conversation"
          >
            <PlusIcon />
          </Button>
        </SidebarGroupLabel>
        <SidebarGroupContent>
          {conversationsLoading ? (
            <p className="text-xs text-muted-foreground px-2">{t("Loading…")}</p>
          ) : chatConversations.length === 0 ? (
            <p className="text-xs text-muted-foreground px-2">{t("No conversations yet")}</p>
          ) : (
            <div ref={chatScrollRef} className="max-h-[min(44vh,600px)] overflow-y-auto">
              <div
                style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}
              >
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const item = railItems[virtualRow.index]!;
                  const conv = item.conv;
                  const isChild = conv.parentConversationId !== null;
                  const title = isChild
                    ? `${conversationDisplayName(conv)}`
                    : conversationDisplayName(conv);
                  return (
                    <div
                      key={conv.conversationId}
                      ref={virtualizer.measureElement}
                      data-index={virtualRow.index}
                      className="h-9"
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          isActive={pathname === `/chat/${conv.conversationId}`}
                          tooltip={isChild ? `Team · ${title}` : title}
                          onClick={() => {
                            closeMobile();
                            markRead(conv.conversationId, conv.lastSeq ?? 0);
                            router.push(`/chat/${conv.conversationId}`);
                          }}
                          className={isChild ? "pl-6" : undefined}
                        >
                          {isChild ? (
                            <UsersIcon className="size-3 shrink-0 text-muted-foreground" />
                          ) : (
                            <MessageSquareIcon />
                          )}
                          {isUnread(conv.conversationId, conv.lastSeq) && (
                            <span
                              className="size-1.5 rounded-full bg-primary shrink-0"
                              aria-hidden
                            />
                          )}
                          <span className="truncate">{title}</span>
                          {!isChild && item.childCount > 0 ? (
                            <span
                              role="button"
                              tabIndex={0}
                              aria-label={`Team rooms (${item.childCount})`}
                              aria-expanded={expanded.has(conv.conversationId)}
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpanded((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(conv.conversationId))
                                    next.delete(conv.conversationId);
                                  else next.add(conv.conversationId);
                                  return next;
                                });
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setExpanded((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(conv.conversationId))
                                      next.delete(conv.conversationId);
                                    else next.add(conv.conversationId);
                                    return next;
                                  });
                                }
                              }}
                              className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                            >
                              {expanded.has(conv.conversationId) ? (
                                <ChevronDownIcon className="size-3" />
                              ) : (
                                <ChevronRightIcon className="size-3" />
                              )}
                            </span>
                          ) : null}
                        </SidebarMenuButton>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <SidebarMenuAction showOnHover aria-label="Conversation actions" />
                            }
                          >
                            <MoreHorizontalIcon />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent side="right" align="start" className="w-44">
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={deleteConversation.isPending}
                              onClick={() => {
                                void (async () => {
                                  const ok = await confirm({
                                    title: `Delete "${title}"?`,
                                    description: "This cannot be undone.",
                                    confirmText: "Delete",
                                    destructive: true,
                                  });
                                  if (!ok) return;
                                  deleteConversation.mutate(conv.conversationId, {
                                    onSuccess: () => {
                                      queryClient.invalidateQueries({
                                        queryKey: conversationKeys.all,
                                      });
                                      if (pathname === `/chat/${conv.conversationId}`) {
                                        router.push("/today");
                                      }
                                    },
                                    onError: (err) => {
                                      toast.error("Failed to delete conversation", {
                                        description:
                                          err instanceof Error ? err.message : "Unknown error",
                                      });
                                    },
                                  });
                                })();
                              }}
                            >
                              <Trash2Icon />
                              Delete conversation
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </SidebarMenuItem>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </SidebarGroupContent>
      </SidebarGroup>

      {/* Team & Projects */}
      <SidebarGroup>
        <SidebarGroupLabel>{t("Team & Projects")}</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={
                  pathname === "/team" ||
                  (pathname.startsWith("/team/") &&
                    !["skills", "mcp", "projects"].some((r) => pathname.startsWith(`/team/${r}`)))
                }
                tooltip={t("Members")}
                onClick={() => {
                  closeMobile();
                  router.push("/team");
                }}
              >
                <BotIcon />
                <span className="truncate">{t("Members")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/team/projects")}
                tooltip={t("Projects")}
                onClick={() => {
                  closeMobile();
                  router.push("/team/projects");
                }}
              >
                <FolderKanbanIcon />
                <span className="truncate">{t("Projects")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {/* Capabilities */}
      <SidebarGroup>
        <SidebarGroupLabel>{t("Capabilities")}</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/wiki")}
                tooltip={t("Wiki")}
                onClick={() => {
                  closeMobile();
                  router.push("/wiki");
                }}
              >
                <BookOpenIcon />
                <span className="truncate">{t("Wiki")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/team/skills")}
                tooltip={t("Skills")}
                onClick={() => {
                  closeMobile();
                  router.push("/team/skills");
                }}
              >
                <Package />
                <span className="truncate">{t("Skills")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/team/mcp")}
                tooltip="MCP"
                onClick={() => {
                  closeMobile();
                  router.push("/team/mcp");
                }}
              >
                <PlugIcon />
                <span className="truncate">{t("MCP")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {/* System */}
      <SidebarGroup>
        <SidebarGroupLabel>{t("System")}</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={
                  pathname === "/system" ||
                  (pathname.startsWith("/system") &&
                    !["settings", "authority"].some((r) => pathname.startsWith(`/system/${r}`)))
                }
                tooltip={t("Observability")}
                onClick={() => {
                  closeMobile();
                  router.push("/system");
                }}
              >
                <ActivityIcon />
                <span className="truncate">{t("Observability")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/system/authority")}
                tooltip={t("Authority")}
                onClick={() => {
                  closeMobile();
                  router.push("/system/authority");
                }}
              >
                <ScaleIcon />
                <span className="truncate">{t("Authority")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/system/settings")}
                tooltip={t("Settings")}
                onClick={() => {
                  closeMobile();
                  router.push("/system/settings");
                }}
              >
                <SettingsIcon />
                <span className="truncate">{t("Settings")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/channels")}
                tooltip={t("Channels")}
                onClick={() => {
                  closeMobile();
                  router.push("/channels");
                }}
              >
                <RadioIcon />
                <span className="truncate">{t("Channels")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {/* ADR 0076: an optional project binds the room — dispatch, brief and
       * terminal all follow it. "No project" keeps ad-hoc rooms undemanding. */}
      <Dialog
        open={newOpen}
        onOpenChange={(open) => {
          if (!open) setNewOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("New conversation")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {t(
                "Talk to the front desk, or pick a team member for a direct line (bypasses routing).",
              )}
            </p>
            <Select value={newAgent} onValueChange={(v) => setNewAgent(v ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder={t("Front desk")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="front">{t("Front desk")}</SelectItem>
                {(agents ?? [])
                  .filter((a) => a.enabled !== false && a.id !== "default")
                  .map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.role === "worker" ? `${a.name} ${t("(direct line)")}` : a.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t("Bind it to a project so the room's work happens in that project's copy.")}
            </p>
            <Select value={newProject} onValueChange={(v) => setNewProject(v ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder={t("No project")} />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.projectId} value={project.projectId}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNewOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button
              disabled={createConversation.isPending}
              onClick={() => {
                setNewOpen(false);
                makeConversation(
                  newProject === "" ? undefined : newProject,
                  newAgent === "front" ? undefined : newAgent,
                );
              }}
            >
              {t("Create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </SidebarContent>
  );
}

function NavFooter() {
  const router = useRouter();
  const { data: user } = useCurrentUser();

  async function signOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <SidebarFooter className="shrink-0 border-t border-(--hairline) bg-(--panel) p-1.5">
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger render={<SidebarMenuButton className="min-w-0 w-full" />}>
              <LogOutIcon />
              <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:hidden">
                {user?.userId ?? "Account"}
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-48">
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  {t("Signed in as")} {user?.userId ?? "unknown"}
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              {/* ADR 0079: the UI language lives here — a shell-wide setting
                  belongs in the operator menu, not on a page. */}
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("Language")}</DropdownMenuLabel>
              </DropdownMenuGroup>
              {/* Base UI: a radio group holds radio items only — a group nested
                  inside it kept the whole menu from opening. */}
              <DropdownMenuRadioGroup
                value={currentLocale()}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  chooseLocale(value);
                  window.location.reload();
                }}
              >
                {localeOptions.map((option) => (
                  <DropdownMenuRadioItem key={option.value} value={option.value}>
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
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
            oh-my-agent
          </span>
          <SidebarTrigger className="hidden md:flex" />
        </div>
      </SidebarHeader>
      <NavContent />
      <NavFooter />
    </Sidebar>
  );
}
