"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { MonoLabel, StatusPill } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAgentDetail, useAgentList } from "@/features/agents/hooks";
import { useUpdateAgent } from "@/features/agents/mutations";
import type { AgentRow } from "@/lib/api";
import {
  type AmbientRuleRow,
  type AmbientRuleWire,
  deriveRuleId,
  ruleToWire,
  splitList,
} from "./ambient-rule-form";

/** ADR 0046: what an OBSERVED (unaddressed) group message may become.
 *
 *  Two modes, and the safe one is the default: `record` only writes a
 *  `proactive_event` row ("this is what it would have done"), `act` frames the
 *  message as a task and starts a run. Editing here replaces the whole list
 *  (`lark.ambientRules` is replace-semantics) — that is why the row actions
 *  rebuild the array instead of patching one rule. */

type RuleRow = AmbientRuleRow;
type WireRule = AmbientRuleWire;

interface RuleDraft {
  /** Position in the array; -1 = new rule. */
  index: number;
  id: string;
  keyword: string;
  mode: "record" | "act";
  instruction: string;
  agent: string;
  chats: string;
  senders: string;
}

const EMPTY_DRAFT: RuleDraft = {
  index: -1,
  id: "",
  keyword: "",
  mode: "record",
  instruction: "",
  agent: "",
  chats: "",
  senders: "",
};

function toDraft(rule: RuleRow, index: number): RuleDraft {
  return {
    index,
    id: rule.id,
    keyword: rule.keyword,
    mode: rule.mode,
    instruction: rule.instruction,
    agent: rule.agent ?? "",
    chats: rule.chats.join(", "),
    senders: rule.senders.join(", "),
  };
}

export function AmbientRulesSection({ agentId }: { agentId: string }) {
  const { data: agent } = useAgentDetail(agentId) as { data?: AgentRow };
  const { data: agents } = useAgentList() as { data?: AgentRow[] };
  const update = useUpdateAgent(agentId);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rules: RuleRow[] = agent?.lark?.ambientRules ?? [];
  const larkOn = agent?.lark?.enabled === true;
  const roster = agents ?? [];

  function save(next: WireRule[]) {
    update.mutate(
      { lark: { ambientRules: next } },
      {
        onError: (err) =>
          toast.error("Could not save rules", {
            description: err instanceof Error ? err.message : "Unknown error",
          }),
      },
    );
  }

  function commit() {
    if (draft === null) return;
    const keyword = draft.keyword.trim();
    if (keyword === "") {
      setError("A keyword is required — it is what the message must contain.");
      return;
    }
    if (draft.mode === "act" && draft.instruction.trim() === "") {
      setError("An act rule needs an instruction — otherwise the run does not know its job.");
      return;
    }
    const id = draft.id.trim() === "" ? deriveRuleId(keyword) : draft.id.trim();
    if (draft.index === -1 && rules.some((r) => r.id === id)) {
      setError(`A rule with id "${id}" already exists — ids must be unique.`);
      return;
    }
    // The wire shape takes `agent` as optional, not nullable — an explicit
    // null is rejected, so an empty target is omitted rather than sent.
    const row: WireRule = {
      id,
      keyword,
      mode: draft.mode,
      instruction: draft.instruction,
      ...(draft.agent === "" ? {} : { agent: draft.agent }),
      chats: splitList(draft.chats),
      senders: splitList(draft.senders),
    };
    const next =
      draft.index === -1
        ? [...rules.map(ruleToWire), row]
        : rules.map(ruleToWire).map((r, i) => (i === draft.index ? row : r));
    setError(null);
    setDraft(null);
    save(next);
  }

  async function remove(rule: RuleRow) {
    const ok = await confirm({
      title: `Delete rule "${rule.id}"?`,
      description:
        rule.mode === "act"
          ? "This rule currently starts runs on matching messages. Deleting it stops that."
          : "It only writes ledger rows today.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    save(rules.filter((r) => r.id !== rule.id).map(ruleToWire));
  }

  const targetLabel = (id: string | null) => {
    if (id === null || id === "") return "this agent";
    return roster.find((a) => a.id === id)?.name ?? id;
  };

  return (
    <section className="rounded-lg border border-(--hairline) bg-(--panel) shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-(--hairline) px-4 py-3">
        <div className="flex items-center gap-2">
          <MonoLabel>Ambient rules</MonoLabel>
          <StatusPill tone={rules.some((r) => r.mode === "act") ? "waiting" : "idle"}>
            {rules.length} rule{rules.length === 1 ? "" : "s"}
          </StatusPill>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setError(null);
            setDraft({ ...EMPTY_DRAFT });
          }}
        >
          <Plus />
          Add rule
        </Button>
      </div>

      <div className="space-y-3 px-4 py-3">
        <p className="text-xs/relaxed text-(--mute)">
          A rule turns a group message that mentions nobody into work.{" "}
          <span className="text-(--ink-strong)">Record</span> only writes what it would have done —
          check that ledger before switching a rule to{" "}
          <span className="text-(--ink-strong)">act</span>, which starts the run without asking you.
        </p>
        {!larkOn && (
          <p className="rounded border border-(--warn)/40 bg-(--warn)/10 px-2 py-1.5 text-[11px] text-(--warn)">
            Lark is off for this agent, so no group message reaches these rules. They take effect
            once a bot is bound.
          </p>
        )}

        {rules.length === 0 ? (
          <p className="text-xs text-(--mute)">
            No rules. Without one, an unaddressed group message is only stored as context.
          </p>
        ) : (
          <div className="divide-y divide-(--hairline)">
            {rules.map((rule, index) => (
              <div key={rule.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="w-40 shrink-0 truncate font-mono text-[11px] text-(--ink-strong)">
                  {rule.id}
                </span>
                <StatusPill tone={rule.mode === "act" ? "waiting" : "idle"}>{rule.mode}</StatusPill>
                <span
                  className="min-w-0 flex-1 truncate text-xs text-(--body)"
                  title={rule.keyword}
                >
                  “{rule.keyword}”
                </span>
                <span className="shrink-0 font-mono text-[10px] text-(--faint)">
                  {rule.chats.length === 0 ? "all chats" : `${rule.chats.length} chat(s)`}
                  {rule.senders.length > 0 ? ` · ${rule.senders.length} sender(s)` : ""}
                  {" → "}
                  {targetLabel(rule.agent)}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Edit rule ${rule.id}`}
                  onClick={() => {
                    setError(null);
                    setDraft(toDraft(rule, index));
                  }}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Delete rule ${rule.id}`}
                  onClick={() => void remove(rule)}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
        <p className="text-[10px] text-(--faint)">
          Order is precedence: the first matching rule wins, so put narrow rules above broad ones.
        </p>
      </div>

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {draft?.index === -1 ? "New ambient rule" : "Edit ambient rule"}
            </DialogTitle>
            <DialogDescription>
              Fires on unaddressed group messages whose text contains the keyword (case-insensitive
              substring — not a regex).
            </DialogDescription>
          </DialogHeader>
          {draft !== null && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="rule-keyword">Keyword</Label>
                  <Input
                    id="rule-keyword"
                    value={draft.keyword}
                    placeholder="e.g. deploy failed"
                    onChange={(e) => setDraft({ ...draft, keyword: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="rule-id">Rule id</Label>
                  <Input
                    id="rule-id"
                    value={draft.id}
                    placeholder="derived from the keyword"
                    onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Mode</Label>
                <Select
                  value={draft.mode}
                  onValueChange={(v) =>
                    setDraft({ ...draft, mode: v === "act" ? "act" : "record" })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue
                      render={(v) =>
                        v === "act"
                          ? "Act — start the run, no confirmation"
                          : "Record — log what it would have done"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="record">Record — log what it would have done</SelectItem>
                    <SelectItem value="act">Act — start the run, no confirmation</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="rule-instruction">Instruction</Label>
                <Textarea
                  id="rule-instruction"
                  value={draft.instruction}
                  placeholder="The job to frame the message as — required for act"
                  onChange={(e) => setDraft({ ...draft, instruction: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>Hand to</Label>
                <Select
                  value={draft.agent === "" ? "__self" : draft.agent}
                  onValueChange={(v) =>
                    setDraft({ ...draft, agent: v === null || v === "__self" ? "" : v })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue
                      render={(v) =>
                        v === "__self"
                          ? "This agent (the conversation's own)"
                          : (roster.find((a) => a.id === v)?.name ?? v)
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__self">This agent (the conversation's own)</SelectItem>
                    {roster
                      .filter((a) => a.id !== agentId)
                      .map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                          {a.role === "worker" ? " — worker" : ""}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="rule-chats">Chats</Label>
                  <Input
                    id="rule-chats"
                    value={draft.chats}
                    placeholder="oc_…, oc_… (empty = every observed chat)"
                    onChange={(e) => setDraft({ ...draft, chats: e.target.value })}
                  />
                  <p className="text-[10px] text-(--faint)">
                    Chat ids — the bot knows no names here yet.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="rule-senders">Senders</Label>
                  <Input
                    id="rule-senders"
                    value={draft.senders}
                    placeholder="ou_… (empty = any admitted sender)"
                    onChange={(e) => setDraft({ ...draft, senders: e.target.value })}
                  />
                  <p className="text-[10px] text-(--faint)">open_id or human:lark:open_id.</p>
                </div>
              </div>
              {error !== null && <p className="text-[11px] text-(--err)">{error}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={commit} disabled={update.isPending}>
              Save rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </section>
  );
}
