"use client";

import { Activity, Cpu, Database, KeyRound, Server } from "lucide-react";
import { useState } from "react";
import { AssessmentSection } from "@/components/AssessmentSection";
import { DispatchSettingsSection } from "@/components/DispatchSettingsSection";
import { LoginPasswordSection } from "@/components/LoginPasswordSection";
import { ProviderSettingsSection } from "@/components/ProviderSettingsSection";
import { Page, PageBody, PageHeader } from "@/components/page";
import { KpiTile, MonoLabel, StatusPill } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProviders } from "@/features/providers/hooks";
import { useSystemInfo } from "@/features/settings/hooks";
import type { SystemInfo } from "@/lib/api";
import { chooseLocale, currentLocale, localeOptions, t } from "@/lib/i18n";

function EnvRow({ k, v }: { k: string; v: string }) {
  const secret = /KEY|TOKEN|SECRET|PASSWORD/i.test(k);
  return (
    <div className="grid gap-0.5 border-b border-(--hairline)/40 py-1.5 font-mono text-xs sm:grid-cols-[240px_1fr] sm:gap-2 last:border-b-0">
      <dt className="break-all text-(--mute)">
        <span className="mr-1 inline-block size-1.5 rounded-full bg-(--primary)/70" aria-hidden />
        {k}
      </dt>
      <dd className={`break-all tabular-nums ${secret ? "text-(--warn)" : "text-(--body)"}`}>
        {v}
      </dd>
    </div>
  );
}

/** ADR 0079: the interface language. The operator menu offers the same
 *  choice; Settings owns it, because this is where the top-bar avatar sends
 *  people. A switch reloads the page — the dictionary is not reactive. */
function InterfaceLanguageSection() {
  const locale = currentLocale();
  return (
    <section className="rounded-lg border border-(--hairline) bg-(--panel) shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-(--hairline) px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-(--ink)">{t("Language")}</h2>
          <p className="mt-0.5 text-xs text-(--mute)">
            {t("English is the source; the other languages are dictionaries of it.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="ui-language" className="text-xs text-(--mute)">
            {t("Language")}
          </Label>
          <Select
            value={locale}
            onValueChange={(value) => {
              if (typeof value !== "string" || value === locale) return;
              chooseLocale(value);
              window.location.reload();
            }}
          >
            <SelectTrigger id="ui-language" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {localeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </section>
  );
}

function SystemInfoSection({ info }: { info: SystemInfo | undefined }) {
  const [open, setOpen] = useState(false);
  if (!info) return null;
  return (
    <section className="rounded-lg border border-(--hairline) bg-(--panel) shadow-sm">
      <div className="flex items-center justify-between border-b border-(--hairline) px-4 py-3">
        <div className="flex items-center gap-2">
          <Server className="size-4 text-(--accent-violet)" />
          <MonoLabel>System info</MonoLabel>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </Button>
      </div>
      {open && (
        <div className="space-y-4 p-4">
          <div>
            <h4 className="mb-1 font-label-caps text-label-caps uppercase tracking-wider text-(--faint)">
              Environment
            </h4>
            <dl className="rounded-md border border-(--hairline) bg-(--canvas-soft) px-3 py-2">
              {Object.entries(info.env).length === 0 ? (
                <p className="py-1 text-xs text-(--mute)">No env vars exposed.</p>
              ) : (
                Object.entries(info.env).map(([k, v]) => <EnvRow key={k} k={k} v={v} />)
              )}
            </dl>
          </div>
          <div>
            <h4 className="mb-1 font-label-caps text-label-caps uppercase tracking-wider text-(--faint)">
              Paths
            </h4>
            <dl className="rounded-md border border-(--hairline) bg-(--canvas-soft) px-3 py-2">
              {Object.entries(info.paths).map(([k, v]) => (
                <EnvRow key={k} k={k} v={v} />
              ))}
            </dl>
          </div>
        </div>
      )}
    </section>
  );
}

export default function SettingsPage() {
  const systemQuery = useSystemInfo();
  const { data: providersData } = useProviders();
  const providers = providersData?.providers ?? [];
  const configured = providers.filter((p) => p.configured).length;
  const info = systemQuery.data;

  const enabledProviderCount = configured;
  const envCount = info ? Object.keys(info.env).length : 0;
  const sys = systemQuery;
  // Three facts, three states: the path (or "not reported"), still loading, or
  // failed. A dash here used to sit beside the real path one line below, and
  // "?" could mean either of the last two (audit 2026-11-24).
  const dataDir = info?.paths.dataDir ?? null;
  const dirValue = dataDir ?? (sys.isPending ? "…" : sys.isError ? "unavailable" : "not reported");

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "System", href: "/system" }, { label: "Settings" }]}
        title="Settings"
        pill={<StatusPill tone="idle">deployment</StatusPill>}
      />
      <PageBody className="space-y-4">
        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiTile
            label="Providers"
            value={enabledProviderCount}
            detail={`${providers.length} known`}
            icon={KeyRound}
            bar={providers.length > 0 ? (enabledProviderCount / providers.length) * 100 : 0}
            barTone={enabledProviderCount > 0 ? "ok" : "violet"}
          />
          <KpiTile
            label="Env vars"
            value={envCount}
            detail="exposed & masked"
            icon={Activity}
            bar={envCount > 0 ? 100 : 0}
            barTone="violet"
          />
          <KpiTile
            label="Data dir"
            value={dirValue}
            detail={t("where this console keeps its data")}
            icon={Database}
          />
          <KpiTile
            label="Runtime"
            value={sys.isPending ? "…" : sys.isError ? "unknown" : "local"}
            detail={sys.isError ? t("info request failed") : "deployment"}
            icon={Cpu}
          />
        </div>

        <InterfaceLanguageSection />
        <ProviderSettingsSection />
        <DispatchSettingsSection />
        {/* ADR 0048: how much of the "is this work?" decision is delegated. */}
        <AssessmentSection />
        <LoginPasswordSection />
        <SystemInfoSection info={info} />
      </PageBody>
    </Page>
  );
}
