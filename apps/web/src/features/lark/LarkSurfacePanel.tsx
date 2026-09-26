"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import QRCode from "react-qr-code";
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
import { Textarea } from "@/components/ui/textarea";
import { useAgentDetail } from "@/features/agents/hooks";
import { agentKeys } from "@/features/agents/query-keys";
import { larkKeys, larkSurfaceQuery } from "@/features/lark/queries";
import { type AgentRow, api } from "@/lib/api";

/** The agent's Lark surface, driven by ONE read model
 *  (`GET /api/agents/:id/lark`). Everything the page shows - whether it is
 *  connected, why it is not, and which buttons are honest - comes from that
 *  view; the setup session's own link rides that same view.
 *
 *  This panel replaced a second, parallel wizard (`LarkBotPanel`) whose state
 *  machine lived inside the component: two entries meant two answers. */
const STATUS_LABEL: Record<string, string> = {
  not_connected: "Not connected",
  authorizing: "Authorizing",
  starting: "Starting",
  online: "Online",
  degraded: "Needs attention",
  error: "Failed",
};

function countdown(expiresAt: number | null): string | null {
  if (!expiresAt) return null;
  const left = Math.max(0, expiresAt - Date.now());
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function LarkSurfacePanel({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: agent } = useAgentDetail(agentId) as { data?: AgentRow };
  const { data: surface, isPending: surfaceLoading } = useQuery(larkSurfaceQuery(agentId));
  /** The surface view is the single source of truth for the state - including
   *  the authorization link. Anything that changes the state must therefore
   *  refresh the view, or the panel keeps showing the screen it was on when
   *  the button was pressed. */
  const refreshSurface = () => qc.invalidateQueries({ queryKey: larkKeys.surface(agentId) });

  // Settings (ported from the panel this replaced, including the rule that
  // `enabled` is never sent: the backend reads `enabled: true` as "turn it
  // on", which demands appId+appSecret whenever no profile exists yet).
  const [botName, setBotName] = useState("");
  const [accessMode, setAccessMode] = useState<"everyone" | "selected" | "nobody">("nobody");
  const [sendersText, setSendersText] = useState("");
  const [groupPolicy, setGroupPolicy] = useState<"disabled" | "open" | "allowlist">("disabled");
  const [requireMention, setRequireMention] = useState(true);
  const [respondAll, setRespondAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [busy, setBusy] = useState(false);
  /** The create flow links here as `?setup=lark`: the user asked for Lark
   *  when creating the agent, so making them find a button afterwards is the
   *  "switch is on, why doesn't it work" trap. One automatic attempt. */
  const autoStarted = useRef(false);
  const wantsSetup = useSearchParams().get("setup") === "lark";

  useEffect(() => {
    if (!agent) return;
    setBotName(agent.lark?.botDisplayName ?? "");
    const senders = agent.lark?.allowedSenders ?? [];
    if (senders.includes("*")) {
      setAccessMode("everyone");
      setSendersText("");
    } else if (senders.length === 0) {
      // Empty means nobody can reach the bot - never "everyone".
      setAccessMode("nobody");
      setSendersText("");
    } else {
      setAccessMode("selected");
      setSendersText(senders.join(", "));
    }
    setGroupPolicy(agent.lark?.groupPolicy ?? "disabled");
    setRequireMention(agent.lark?.requireMention ?? true);
    setRespondAll(agent.lark?.respondToMentionAll ?? false);
  }, [agent]);

  // The link, the countdown and the outcome all come from the surface view,
  // which polls itself while it is still moving. The only thing left to do
  // here is re-read the agent row once authorization ends: the config it
  // carries (app id, profile) is written on completion.
  const wasAuthorizing = useRef(false);
  useEffect(() => {
    const authorizing = surface?.status === "authorizing";
    if (wasAuthorizing.current && !authorizing) {
      void qc.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
    }
    wasAuthorizing.current = authorizing;
  }, [agentId, qc, surface?.status]);

  const startSetupRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!wantsSetup || autoStarted.current) return;
    if (surface?.status !== "not_connected" || surface.actions.canStartSetup === false) return;
    autoStarted.current = true;
    void startSetupRef.current();
  }, [wantsSetup, surface?.status, surface?.actions.canStartSetup]);

  const startSetup = async () => {
    setBusy(true);
    setError("");
    try {
      await api.larkSetup(agentId, { botDisplayName: botName.trim() || undefined });
      // The session is pending now: without this the view still reads
      // not_connected and its polling stays off.
      await refreshSurface();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start Lark setup");
    } finally {
      setBusy(false);
    }
  };

  const cancelSetup = async () => {
    const id = surface?.setup.id ?? null;
    if (id) await api.larkSetupCancel(agentId, id).catch(() => {});
    await refreshSurface();
  };

  /** Restart is a composed capability: toggling `enabled` off then on runs the
   *  same stop/start lifecycle the registry owns. */
  const retryStart = async () => {
    setBusy(true);
    setError("");
    try {
      await api.updateAgent(agentId, { lark: { enabled: false } });
      await api.updateAgent(agentId, { lark: { enabled: true } });
      await qc.invalidateQueries({ queryKey: larkKeys.surface(agentId) });
      await qc.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to restart the bot");
    } finally {
      setBusy(false);
    }
  };

  const groupNameMissing = groupPolicy !== "disabled" && botName.trim() === "";

  const saveSettings = async () => {
    if (groupNameMissing) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const allowedSenders =
        accessMode === "everyone"
          ? ["*"]
          : accessMode === "nobody"
            ? []
            : sendersText
                .split(/[\s,]+/)
                .map((v) => v.trim())
                .filter(Boolean);
      await api.updateAgent(agentId, {
        lark: {
          botDisplayName: botName,
          allowedSenders,
          groupPolicy,
          requireMention,
          respondToMentionAll: respondAll,
        },
      });
      await qc.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
      await qc.invalidateQueries({ queryKey: larkKeys.surface(agentId) });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save Lark settings");
    } finally {
      setSaving(false);
    }
  };

  startSetupRef.current = startSetup;

  if (surfaceLoading && !surface) {
    // A default of "not connected" here put a working Connect button on screen
    // before the read model answered - the first click raced the load.
    return (
      <div className="rounded-(--radius-card) border border-(--hairline) bg-(--panel) p-4 text-sm text-muted-foreground">
        Checking the Lark surface...
      </div>
    );
  }

  const status = surface?.status ?? "not_connected";
  const issue = surface?.setup.issue ?? null;
  // The link belongs to the server-side session, not to this component: a
  // reload or a second tab must still find it, so the view is the only source.
  const url = surface?.setup.url ?? "";
  const expires = countdown(surface?.setup.expiresAt ?? null);

  const settingsCard = (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="lark-bot-name">Bot display name</Label>
        <Input
          id="lark-bot-name"
          value={botName}
          onChange={(e) => setBotName(e.target.value)}
          placeholder="backend-agent"
        />
        <p
          className={
            groupNameMissing ? "text-xs text-destructive" : "text-xs text-muted-foreground"
          }
        >
          Groups recognize @mentions by this name, so it must match the bot's name in Lark. Leave it
          empty and the bot only works in direct messages.
          {groupNameMissing ? " Groups are enabled, so this cannot be saved empty." : ""}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>Who may use it</Label>
        <Select value={accessMode} onValueChange={(v) => setAccessMode(v as typeof accessMode)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="everyone">Everyone in the tenant</SelectItem>
            <SelectItem value="selected">Only the members I list</SelectItem>
            <SelectItem value="nobody">Nobody (paused for access)</SelectItem>
          </SelectContent>
        </Select>
        {accessMode === "selected" && (
          <Textarea
            value={sendersText}
            onChange={(e) => setSendersText(e.target.value)}
            placeholder="open_id, one per line"
            rows={3}
          />
        )}
        <p className="text-xs text-muted-foreground">
          Members are stored as Lark open_ids. A member picker needs a contacts scope the app does
          not have yet.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>Groups</Label>
        <Select value={groupPolicy} onValueChange={(v) => setGroupPolicy(v as typeof groupPolicy)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="disabled">Direct messages only</SelectItem>
            <SelectItem value="open">Any group the bot is in</SelectItem>
            <SelectItem value="allowlist">Only groups I list</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={requireMention}
            onCheckedChange={(v) => setRequireMention(v === true)}
          />
          Require @bot in groups
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={respondAll} onCheckedChange={(v) => setRespondAll(v === true)} />
          Also answer @all
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={saving || groupNameMissing} onClick={() => void saveSettings()}>
          {saving ? "Saving..." : "Save settings"}
        </Button>
        {saved && <span className="text-xs text-muted-foreground">Saved</span>}
      </div>
    </div>
  );

  return (
    <div className="space-y-4 rounded-(--radius-card) border border-(--hairline) bg-(--panel) p-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">Lark</h3>
        <Badge variant={status === "online" ? "default" : "secondary"} className="text-xs">
          {STATUS_LABEL[status] ?? status}
        </Badge>
        {surface?.brand === "lark" && (
          <span className="text-xs text-muted-foreground">Lark Suite</span>
        )}
      </div>

      {issue && (
        <div className="space-y-2 rounded-md border border-destructive/40 p-3">
          <p className="text-sm text-foreground">{issue.title}</p>
          <div className="flex flex-wrap items-center gap-2">
            {issue.action === "restart_setup" || issue.action === "reconnect" ? (
              <Button size="sm" disabled={busy} onClick={() => void startSetup()}>
                Reconnect
              </Button>
            ) : null}
            {issue.action === "restart_surface" ? (
              <Button size="sm" disabled={busy} onClick={() => void retryStart()}>
                Retry start
              </Button>
            ) : null}
            <Link className="text-xs text-muted-foreground underline" href="/system">
              Diagnostics
            </Link>
          </div>
        </div>
      )}

      {status === "not_connected" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Let this agent work in Lark: authorize a bot app once, then send it a message.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="lark-connect-name">Bot display name</Label>
            <Input
              id="lark-connect-name"
              value={botName}
              onChange={(e) => setBotName(e.target.value)}
              placeholder="backend-agent"
            />
            <p className="text-xs text-muted-foreground">
              Used to recognize @mentions in groups; it must match the name in Lark.
            </p>
          </div>
          <Button
            size="sm"
            disabled={busy || surface?.actions.canStartSetup === false}
            onClick={() => void startSetup()}
          >
            {busy ? "Starting..." : "Connect Lark"}
          </Button>
        </div>
      )}

      {status === "authorizing" && (
        <div className="space-y-3">
          <ol className="list-decimal space-y-1 pl-4 text-sm text-muted-foreground">
            <li>Scan the code with Lark.</li>
            <li>Pick an existing bot app or create one.</li>
            <li>This page continues on its own once you finish.</li>
          </ol>
          {url ? (
            <div className="flex items-center gap-4">
              <div className="rounded-md bg-white p-2">
                <QRCode value={url} size={112} />
              </div>
              <div className="space-y-2">
                {expires && (
                  <p className="text-xs text-muted-foreground">Link expires in {expires}</p>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void navigator.clipboard.writeText(url)}
                >
                  Copy link
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Asking lark-cli for the link...</p>
          )}
          <Button size="sm" variant="ghost" onClick={() => void cancelSetup()}>
            Cancel
          </Button>
        </div>
      )}

      {status === "starting" && (
        <p className="text-sm text-muted-foreground">
          Authorization is done; waiting for the bot to report in.
        </p>
      )}

      {status === "online" && (
        <div className="space-y-2 text-sm text-muted-foreground">
          <p className="text-foreground">The bot is online.</p>
          <ul className="list-disc space-y-1 pl-4">
            <li>Send it a direct message, or</li>
            <li>
              @{surface?.botDisplayName ?? "the bot"} in a group
              {surface?.groupMention.ready === false && (
                <span className="text-destructive"> - groups are not ready yet</span>
              )}
            </li>
          </ul>
        </div>
      )}

      {(status === "authorizing" || status === "starting" || status === "online" || issue) &&
        settingsCard}

      <details className="space-y-2">
        <summary className="cursor-pointer text-xs text-muted-foreground">Advanced</summary>
        <div className="space-y-1 pt-2 text-xs text-muted-foreground">
          <div>Profile: {agent?.lark?.profileRef ?? "-"}</div>
          <div>
            App: {surface?.brand === "lark" ? "Lark Suite app" : (agent?.lark?.appId ?? "-")}
          </div>
          <div>
            Last heartbeat:{" "}
            {surface?.health.lastSeenAt
              ? `${Math.floor((Date.now() - surface.health.lastSeenAt) / 1000)}s ago`
              : "never"}
          </div>
          {surface?.health.lastError && (
            <div className="text-destructive">Last error: {surface.health.lastError}</div>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {surface?.actions.canRestart && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void retryStart()}>
                Restart bot
              </Button>
            )}
            {surface?.actions.canDisable && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void api.updateAgent(agentId, { lark: { enabled: false } }).then(() => {
                    void qc.invalidateQueries({ queryKey: larkKeys.surface(agentId) });
                  })
                }
              >
                Stop the bot
              </Button>
            )}
            <Link className="text-xs text-muted-foreground underline" href="/system">
              Open diagnostics
            </Link>
          </div>
        </div>
      </details>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
