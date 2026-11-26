"use client";

import { Bot, CheckCircle2, KeyRound, MessageSquare, Package } from "lucide-react";
import Link from "next/link";
import { useAgentList } from "@/features/agents/hooks";
import { useModelList } from "@/features/models/hooks";
import { useSkillPackList } from "@/features/skill-packs/hooks";
import { t } from "@/lib/i18n";

/** First-run checklist: agent → model → skill pack → first chat. Steps
 *  auto-check as their data appears. Shown in empty states only. */
export function OnboardingChecklist() {
  const { data: agents } = useAgentList();
  const { data: models } = useModelList();
  const { data: packs } = useSkillPackList();

  const steps = [
    {
      done: (agents ?? []).length > 0,
      icon: Bot,
      title: t("Create an agent"),
      desc: t("Give it a persona, model, and workspace."),
      href: "/team",
    },
    {
      // An agent row exists even with the unconfigured seed model — only a
      // reachable provider catalog means runs can actually start (T3-1).
      done: (models?.providers ?? []).length > 0,
      icon: KeyRound,
      title: t("Configure a model"),
      desc: t("Add a provider key so the agent can actually run."),
      href: "/system/settings",
    },
    {
      done: (packs ?? []).some((p) => p.status === "ready"),
      icon: Package,
      title: t("Install a skill pack"),
      desc: t("Bundled skills the agent can use."),
      href: "/team/skills",
    },
    {
      done: false,
      icon: MessageSquare,
      title: t("Start a chat"),
      desc: t("Pick an agent and send the first message."),
      href: "/chat",
    },
  ];

  return (
    <ol className="mx-auto w-full max-w-sm space-y-1">
      {steps.map((s) => (
        <li key={s.href}>
          <Link
            href={s.href}
            className={`flex items-center gap-3 rounded-lg border border-(--hairline) px-3 py-2.5 transition-colors hover:border-(--primary) ${
              s.done ? "opacity-60" : ""
            }`}
          >
            {s.done ? (
              <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
            ) : (
              <s.icon className="size-4 shrink-0 text-(--mute)" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-(--ink-strong)">{s.title}</span>
              <span className="block text-xs text-(--mute)">{s.desc}</span>
            </span>
            {s.done && <span className="text-[10px] text-(--mute)">{t("Done")}</span>}
          </Link>
        </li>
      ))}
    </ol>
  );
}
