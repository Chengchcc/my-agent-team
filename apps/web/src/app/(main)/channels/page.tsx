"use client";

import { useQueries } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
  type ChannelConfig,
  type ChannelSurface,
  channelActions,
  configurationLook,
  connectionLook,
  hasApp,
  runningLook,
} from "@/components/channels/channel-facts";
import { fmtAgo } from "@/components/ops/format";
import { Note, PanelCell, PanelRow, PanelTable, StatusBadge } from "@/components/ops/kit";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button, buttonVariants } from "@/components/ui/button";
import { RoleAvatar } from "@/components/ui/role-avatar";
import { useAgentList } from "@/features/agents/hooks";
import { useUpdateAgent } from "@/features/agents/mutations";
import { useLarkSetup } from "@/features/lark/mutations";
import { larkSurfaceQuery } from "@/features/lark/queries";
import type { AgentRow } from "@/lib/api";
import { t } from "@/lib/i18n";

/** The configuration and the process word, both read from the agent row. */
function configOf(agent: AgentRow): ChannelConfig {
  const lark = agent.lark;
  return {
    enabled: lark?.enabled === true,
    appId: lark?.appId ?? null,
    profileRef: lark?.profileRef ?? null,
    status: lark?.status ?? "not_configured",
  };
}

/** When the surface last answered. Never connected is a fact, not an error. */
function lastSeenLine(surface: ChannelSurface | null, now: number): string {
  const at = surface?.health.lastSeenAt ?? null;
  if (at === null) return t("Never connected");
  return `${t("Last seen")} ${fmtAgo(at, now)}`;
}

/** One PA and its Lark bot. A bot belongs to its PA; this page states four
 *  facts about it and offers the two switch positions and the setup. The
 *  configuration itself lives on the agent's Lark tab — there is one wizard
 *  and one state machine, not a second one here. */
function ChannelRow({
  agent,
  surface,
  now,
}: {
  agent: AgentRow;
  surface: ChannelSurface | null;
  now: number;
}) {
  const router = useRouter();
  const update = useUpdateAgent(agent.id);
  const setup = useLarkSetup(agent.id);
  const config = configOf(agent);
  const actions = channelActions(config, surface);
  const pending = update.isPending || setup.isPending;
  const larkTab = `/team/${agent.id}?tab=lark`;

  function report(error: unknown) {
    toast.error(t("The request was refused"), {
      description: error instanceof Error ? error.message : String(error),
    });
  }
  function enable() {
    update.mutate({ lark: { enabled: true } }, { onError: report });
  }
  function disable() {
    update.mutate({ lark: { enabled: false } }, { onError: report });
  }
  function startSetup() {
    // The wizard (the QR code, the wait for the authorization) is the agent's
    // Lark tab; starting the session here and opening that tab keeps one wizard.
    setup.mutate(
      {},
      {
        onSuccess: () => router.push(larkTab),
        onError: report,
      },
    );
  }

  return (
    <PanelRow>
      <PanelCell label={t("Channel")}>
        <Link
          href={larkTab}
          className="flex items-center gap-2 text-(--ink) transition-colors hover:text-(--primary)"
        >
          <RoleAvatar kind="pa" name={agent.name} size="sm" />
          <span className="min-w-0">
            <span className="block truncate text-xs font-[550]">
              {agent.lark?.botDisplayName ?? agent.name}
            </span>
            <span className="block truncate text-[10px] text-(--faint)">{agent.name}</span>
          </span>
        </Link>
      </PanelCell>
      <PanelCell label={t("Configuration")}>
        <StatusBadge look={configurationLook(config)} />
        <Note className="mt-1">{hasApp(config) ? t("App set") : t("No app")}</Note>
      </PanelCell>
      <PanelCell label={t("Deployment")}>
        <span className="text-(--mute)">{t("Not provided")}</span>
      </PanelCell>
      <PanelCell label={t("Process")}>
        <StatusBadge look={runningLook(config.status)} />
      </PanelCell>
      <PanelCell label={t("Connection")}>
        <StatusBadge look={connectionLook(surface)} />
        <Note className="mt-1">{lastSeenLine(surface, now)}</Note>
      </PanelCell>
      <PanelCell label={t("Last error")} className="md:max-w-64">
        <span className="text-(--mute)">{surface?.health.lastError ?? "—"}</span>
      </PanelCell>
      <PanelCell label={t("Actions")}>
        <div className="flex flex-wrap gap-1.5">
          {actions.canSetUp && (
            <Button size="sm" disabled={pending} onClick={startSetup}>
              {t("Set up")}
            </Button>
          )}
          {actions.canEnable && (
            <Button size="sm" variant="outline" disabled={pending} onClick={enable}>
              {t("Enable")}
            </Button>
          )}
          {actions.canDisable && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={disable}>
              {t("Disable")}
            </Button>
          )}
          <Link href={larkTab} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            {t("Configure")}
          </Link>
        </div>
      </PanelCell>
    </PanelRow>
  );
}

/** Channels: every PA's Lark bot as one row. Configuration, deployment, the
 *  running process and the connection are four facts from four sources; the
 *  product reports no deployment state, so that column says so. */
export default function ChannelsPage() {
  const agentsQuery = useAgentList();
  const agents = (agentsQuery.data ?? []).filter((a) => a.role !== "worker" && !a.archivedAt);
  const surfaces = useQueries({ queries: agents.map((a) => larkSurfaceQuery(a.id)) });
  const now = Date.now();

  let body: ReactNode;
  if (agentsQuery.isPending) {
    body = <p className="py-8 text-sm text-(--mute)">{t("Loading…")}</p>;
  } else if (agentsQuery.isError) {
    body = (
      <div className="flex items-center gap-3 py-8 text-sm text-(--err)">
        <span>{t("Could not load the team.")}</span>
        <Button size="sm" variant="outline" onClick={() => agentsQuery.refetch()}>
          {t("Retry")}
        </Button>
      </div>
    );
  } else if (agents.length === 0) {
    body = (
      <div className="py-8">
        <p className="text-sm text-(--ink)">{t("No personal agent yet.")}</p>
        <Note className="mt-1">
          <Link href="/team" className="text-(--primary) hover:underline">
            {t("Open the team page")}
          </Link>
        </Note>
      </div>
    );
  } else {
    body = (
      <PanelTable
        label={t("Channels")}
        columns={[
          t("Channel"),
          t("Configuration"),
          t("Deployment"),
          t("Process"),
          t("Connection"),
          t("Last error"),
          t("Actions"),
        ]}
      >
        {agents.map((agent, index) => (
          <ChannelRow
            key={agent.id}
            agent={agent}
            surface={surfaces[index]?.data ?? null}
            now={now}
          />
        ))}
      </PanelTable>
    );
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "System" }, { label: "Channels" }]}
        title={t("Channels")}
        subtitle={t("One row per PA and its Lark bot.")}
      />
      <PageBody>
        <p className="mb-4 max-w-3xl text-xs/relaxed  text-(--mute)">
          {t(
            "Configuration, deployment, the running process and the connection are four separate facts. None is read off another: an enabled switch does not mean the bot is up.",
          )}
        </p>
        {body}
      </PageBody>
    </Page>
  );
}
