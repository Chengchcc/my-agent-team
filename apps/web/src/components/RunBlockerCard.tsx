"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { ProviderSetupInline } from "@/components/ProviderSetupInline";
import { MonoLabel } from "@/components/patterns";
import { useAgentList } from "@/features/agents/hooks";
import { useHarnessList } from "@/features/models/hooks";
import { blockedHarnesses } from "@/lib/harness-availability";

/** Today's setup blocker. An agent can be seeded while the harness it names is
 *  not startable in this deployment (no bridge installed, provider key missing),
 *  and every dispatch on it then fails — with the cause living in the deployment
 *  rather than in anything the UI shows. Renders nothing while every enabled
 *  agent's harness starts. */
export function RunBlockerCard() {
  const agents = useAgentList();
  const harnesses = useHarnessList();
  if (agents.isPending || harnesses.isPending) return null;

  const enabled = (agents.data ?? []).filter((agent) => agent.enabled !== false);
  if (enabled.length === 0) return null;

  const blocked = blockedHarnesses(enabled, harnesses.data?.harnesses ?? []);
  if (blocked.length === 0) return null;
  const blockedCount = enabled.filter((agent) => blocked.includes(agent.harness)).length;

  return (
    <section className="rounded-lg border border-(--hairline) bg-(--panel) shadow-sm">
      <div className="flex items-center gap-2 border-b border-(--hairline) px-4 py-3">
        <AlertTriangle className="size-4 text-(--warn)" />
        <MonoLabel>Agents cannot run yet</MonoLabel>
      </div>
      <div className="space-y-3 px-4 py-3 text-sm">
        <p>
          {blockedCount} of {enabled.length} agents name a harness this deployment cannot start (
          {blocked.join(", ")}), so every dispatch on them fails. The oma harness needs a provider
          key — it is stored on the server and applies without a restart:
        </p>
        <ProviderSetupInline />
        <p className="text-(--muted-foreground)">
          Other harnesses run through their own agent binary; install it and reload. Using a custom
          provider? Ship <code>models.yml</code> where <code>OMA_HOME</code> points, then restart
          the gateway; <code>oma gateway doctor</code> reports what runs will see. The full list
          lives in{" "}
          <Link className="text-(--primary) underline underline-offset-2" href="/system/settings">
            Settings
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
