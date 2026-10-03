"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentList } from "@/features/agents/hooks";
import { useConversationMembers } from "@/features/conversations/hooks";
import { api } from "@/lib/api";

/** ADR 0041: the conversation's member roster. One member = e2e (every
 *  message triggers); two or more = room (@mention routing) — the chips are
 *  the mode indicator, adding a second member flips the room on its own. */
export function ConversationMembers({ conversationId }: { conversationId: string }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState("");
  const { data: agents } = useAgentList();
  const { data } = useConversationMembers(conversationId);
  const members = data?.members ?? [];
  const agentRows = agents ?? [];
  const nameOf = (id: string) => agentRows.find((a) => a.id === id)?.name ?? id;
  const candidates = agentRows.filter((a) => !members.includes(a.id));

  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ["conversation-members", conversationId] });
  const add = useMutation({
    mutationFn: (agentId: string) => api.addConversationMember(conversationId, agentId),
    onSuccess: invalidate,
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to add member"),
  });
  const remove = useMutation({
    mutationFn: (agentId: string) => api.removeConversationMember(conversationId, agentId),
    onSuccess: invalidate,
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to remove"),
  });

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {members.map((id) => (
        <span
          key={id}
          className="inline-flex max-w-40 items-center gap-1 rounded-full border border-(--hairline) bg-(--canvas-soft) px-2 py-0.5 text-[10px] text-(--body)"
          title={id}
        >
          <span className="truncate">{nameOf(id)}</span>
          {members.length > 1 && (
            <button
              type="button"
              aria-label={`Remove ${nameOf(id)}`}
              className="text-(--mute) hover:text-(--body)"
              onClick={() => remove.mutate(id)}
            >
              <XIcon className="size-2.5" />
            </button>
          )}
        </span>
      ))}
      {members.length > 1 && (
        <span className="text-[9px] text-(--mute)" title="ADR 0041: @mention routing">
          @-mention to direct
        </span>
      )}
      {adding ? (
        <span className="flex items-center gap-1">
          <Select value={pick} onValueChange={(v) => setPick(v ?? "")}>
            <SelectTrigger className="h-6 w-36 text-[10px]">
              <SelectValue placeholder="Agent" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            disabled={!pick || add.isPending}
            onClick={() => {
              add.mutate(pick);
              setPick("");
              setAdding(false);
            }}
          >
            Add
          </Button>
        </span>
      ) : (
        <button
          type="button"
          aria-label="Add member"
          className="inline-flex size-5 items-center justify-center rounded-full border border-dashed border-(--hairline) text-(--mute) hover:text-(--body)"
          onClick={() => setAdding(true)}
        >
          <PlusIcon className="size-3" />
        </button>
      )}
    </div>
  );
}
