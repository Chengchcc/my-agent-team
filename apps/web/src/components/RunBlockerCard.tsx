"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { ProviderSetupInline } from "@/components/ProviderSetupInline";
import { useAgentList } from "@/features/agents/hooks";
import { useHarnessList } from "@/features/models/hooks";
import { blockedHarnesses } from "@/lib/harness-availability";
import { t } from "@/lib/i18n";

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
    <section
      role="alert"
      className="mb-[25px] rounded-[9px] border border-[#e2bc812c] bg-[#e2bc8108] px-[17px] py-[13px]"
    >
      <div className="flex items-center gap-2.5">
        <AlertTriangle className="size-4 shrink-0 text-(--warn)" />
        <h2 className="text-[11px]/[1.8]  font-[550] text-(--warn)">
          {t("Members cannot run yet")}
        </h2>
      </div>
      <div className="mt-2 space-y-3 text-[11px]/[1.8]  text-(--body)">
        <p>
          {t(
            "{blocked} of {total} members name a harness this deployment cannot start ({harnesses}), so every dispatch on them fails. The oma harness needs a provider key. It is stored on the server and applies without a restart:",
            {
              blocked: blockedCount,
              total: enabled.length,
              harnesses: blocked.join(", "),
            },
          )}
        </p>
        <ProviderSetupInline />
        <p className="text-(--mute)">
          {t(
            "Other harnesses run through their own agent binary: install it and reload. Using a custom provider, ship models.yml where OMA_HOME points, then restart the gateway; oma gateway doctor reports what runs will see. The full list is in",
          )}{" "}
          <Link className="text-(--primary) underline underline-offset-2" href="/system/settings">
            {t("Settings")}
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
