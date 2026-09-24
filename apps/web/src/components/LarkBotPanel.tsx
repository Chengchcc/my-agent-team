"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentDetail } from "@/features/agents/hooks";
import { agentKeys } from "@/features/agents/query-keys";
import { type AgentRow, api, type LarkSetupSession } from "@/lib/api";

/** Agent-level Lark bot setup (M15.1): initialize a profile for this agent
 *  and start the bot. The setup session is created server-side and resolves
 *  to an external Lark setup URL. */
export function LarkBotPanel({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: agent } = useAgentDetail(agentId) as { data?: AgentRow };
  const [botName, setBotName] = useState(agent?.lark?.botDisplayName ?? "");
  const [session, setSession] = useState<LarkSetupSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Access settings. `"*"` in the allowlist is the explicit wildcard — an
  // empty list means nobody, so the two are distinct choices here.
  const [dmMode, setDmMode] = useState<"everyone" | "selected" | "nobody">("everyone");
  const [sendersText, setSendersText] = useState("");
  const [groupPolicy, setGroupPolicy] = useState<"disabled" | "open" | "allowlist">("disabled");
  const [requireMention, setRequireMention] = useState(true);
  const [respondAll, setRespondAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!agent) return;
    setBotName(agent.lark?.botDisplayName ?? "");
    const senders = agent.lark?.allowedSenders ?? [];
    const wildcard = senders.some((s) => s === "*");
    if (wildcard) {
      setDmMode("everyone");
      setSendersText("");
    } else if (senders.length === 0) {
      // An empty list means nobody can use the bot — not "everyone".
      setDmMode("nobody");
      setSendersText("");
    } else {
      setDmMode("selected");
      setSendersText(senders.join(", "));
    }
    setGroupPolicy(agent.lark?.groupPolicy ?? "disabled");
    setRequireMention(agent.lark?.requireMention ?? true);
    setRespondAll(agent.lark?.respondToMentionAll ?? false);
  }, [agent]);

  useEffect(() => {
    if (session?.status !== "pending") return;
    const timer = setInterval(async () => {
      try {
        const next = await api.larkSetupStatus(agentId, session.setupId);
        setSession(next);
        if (next.status !== "pending") {
          clearInterval(timer);
          void qc.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
          void qc.invalidateQueries({ queryKey: agentKeys.lists() });
        }
      } catch {
        clearInterval(timer);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [agentId, qc, session?.setupId, session?.status]);

  const startSetup = async () => {
    setLoading(true);
    setError("");
    try {
      setSession(
        await api.larkSetup(agentId, {
          botDisplayName: botName.trim() || undefined,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start Lark setup");
    } finally {
      setLoading(false);
    }
  };

  const cancelSetup = async () => {
    try {
      await api.larkSetupCancel(agentId, session!.setupId);
    } catch {
      /* already settled */
    }
    setSession(null);
  };

  const saveAccess = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      let allowedSenders: string[] = [];
      if (dmMode === "everyone") {
        allowedSenders = ["*"];
      } else if (dmMode === "selected") {
        allowedSenders = sendersText
          .split(/[\s,]+/)
          .map((v) => v.trim())
          .filter(Boolean);
      }
      await api.updateAgent(agentId, {
        lark: {
          // `enabled` is deliberately NOT sent. The backend treats
          // `enabled: true` as "turn it on", which requires appId+appSecret
          // whenever the agent has no stored profile yet — so always sending
          // it made every save fail with 400 for an agent in that state (a
          // real one: enabled, no profile_ref). This panel edits access, it
          // does not toggle the bot; when a toggle lands it must send the
          // field only when the value actually changes.
          botDisplayName: botName,
          allowedSenders,
          groupPolicy,
          requireMention,
          respondToMentionAll: respondAll,
        },
      });
      await qc.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save Lark access settings");
    } finally {
      setSaving(false);
    }
  };

  const status = agent?.lark?.status ?? "not_configured";
  const hasProfile = !!agent?.lark?.profileRef;

  return (
    <div className="space-y-4 rounded-(--radius-card) border border-(--hairline) bg-(--panel) p-4">
      <div className="flex items-center gap-2">
        <span className="text-(--text-emph) font-medium text-(--ink)">Lark Bot</span>
        <Badge
          variant={
            status === "running" ? "default" : status === "error" ? "destructive" : "secondary"
          }
        >
          {status}
        </Badge>
      </div>

      {!hasProfile ? (
        <>
          <p className="text-sm text-(--mute)">
            This agent has no Lark profile yet. Initialize one to bind a Lark bot.
          </p>
          <div className="space-y-1">
            <Label>Bot display name</Label>
            <Input
              value={botName}
              onChange={(e) => setBotName(e.target.value)}
              placeholder="Optional - must match Lark app settings"
            />
          </div>

          {session?.status === "pending" ? (
            <div className="space-y-2">
              <p className="text-sm text-(--body)">Open this link to finish setup:</p>
              {session.url ? (
                <a
                  href={session.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-(--chart-2) underline break-all"
                >
                  {session.url}
                </a>
              ) : (
                <p className="text-sm text-amber-600">Waiting for setup URL…</p>
              )}
              <Button variant="ghost" size="sm" onClick={() => void cancelSetup()}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button onClick={() => void startSetup()} disabled={loading}>
              {loading ? "Starting…" : "Initialize Lark Bot"}
            </Button>
          )}

          {error && <p className="text-sm text-(--err)">{error}</p>}
        </>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1">
            <Label>Bot display name</Label>
            <Input
              value={botName}
              onChange={(e) => setBotName(e.target.value)}
              placeholder="e.g. backend-agent"
            />
            <p className="text-xs text-(--mute)">
              Group @mentions are matched against this name. Without it the bot only works in direct
              messages.
            </p>
          </div>

          <div className="space-y-1">
            <Label>Who can use the bot in direct messages</Label>
            <Select value={dmMode} onValueChange={(v) => setDmMode(v as typeof dmMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="everyone">Everyone in the tenant</SelectItem>
                <SelectItem value="selected">Only the people listed below</SelectItem>
                <SelectItem value="nobody">Nobody (turn it off here)</SelectItem>
              </SelectContent>
            </Select>
            {dmMode === "selected" && (
              <Input
                value={sendersText}
                onChange={(e) => setSendersText(e.target.value)}
                placeholder="ou_xxx, ou_yyy"
              />
            )}
            {dmMode === "selected" && (
              <p className="text-xs text-(--mute)">
                Lark open_ids, comma separated. The bot stays silent for anyone else.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label>Groups</Label>
            <Select
              value={groupPolicy}
              onValueChange={(v) => setGroupPolicy(v as typeof groupPolicy)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="disabled">Only groups this bot already works in</SelectItem>
                <SelectItem value="open">Every group it is added to</SelectItem>
                <SelectItem value="allowlist">
                  Every group, but only the people listed above
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-(--mute)">
              Being added to a group does not by itself let it drive this agent. A group the bot has
              already served keeps working either way.
            </p>
          </div>

          <label className="flex items-center gap-2">
            <Checkbox
              checked={requireMention}
              onCheckedChange={(v) => setRequireMention(v === true)}
            />
            <span className="text-sm text-(--ink)">Groups must @mention the bot</span>
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={respondAll} onCheckedChange={(v) => setRespondAll(v === true)} />
            <span className="text-sm text-(--ink)">Let @everyone in a group trigger the bot</span>
          </label>

          <div className="flex items-center gap-2">
            <Button onClick={() => void saveAccess()} disabled={saving}>
              {saving ? "Saving…" : "Save access settings"}
            </Button>
            {saved && <span className="text-sm text-(--mute)">Saved.</span>}
          </div>
          {error && <p className="text-sm text-(--err)">{error}</p>}
        </div>
      )}
    </div>
  );
}
