"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { ProviderSetupInline } from "@/components/ProviderSetupInline";
import { MonoLabel } from "@/components/patterns";
import { useAgentList } from "@/features/agents/hooks";
import { useModelList } from "@/features/models/hooks";
import { blockedBackends } from "@/lib/model-availability";

/** Today's setup blocker. An agent whose backend has no usable model is seeded
 *  anyway, and every dispatch then fails — with the cause living in the
 *  deployment (provider keys, custom catalog) rather than in anything the UI
 *  shows. Renders nothing as long as every enabled agent has a usable model. */
export function RunBlockerCard() {
  const agents = useAgentList();
  const models = useModelList();
  if (agents.isPending || models.isPending) return null;

  const enabled = (agents.data ?? []).filter((agent) => agent.enabled !== false);
  if (enabled.length === 0) return null;

  const catalog = (models.data?.providers ?? []).flatMap((provider) => provider.models);
  const backends = blockedBackends(enabled, catalog);
  if (backends.length === 0) return null;
  const blockedCount = enabled.filter((agent) => backends.includes(agent.backendKind)).length;

  return (
    <section className="rounded-lg border border-(--hairline) bg-(--panel) shadow-sm">
      <div className="flex items-center gap-2 border-b border-(--hairline) px-4 py-3">
        <AlertTriangle className="size-4 text-(--warn)" />
        <MonoLabel>Agents cannot run yet</MonoLabel>
      </div>
      <div className="space-y-3 px-4 py-3 text-sm">
        <p>
          {blockedCount} of {enabled.length} agents have no usable model for their backend (
          {backends.join(", ")}), so every dispatch on them fails. Add a provider key — it is stored
          on the server and applies without a restart:
        </p>
        <ProviderSetupInline />
        <p className="text-(--muted-foreground)">
          Using a custom provider? Ship <code>models.yml</code> where <code>OMA_HOME</code> points,
          then restart the gateway; <code>oma gateway doctor</code> reports what runs will see. The
          full list lives in{" "}
          <Link className="text-(--primary) underline underline-offset-2" href="/system/settings">
            Settings
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
