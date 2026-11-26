"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import { type AskPaRequest, AskPaSheet } from "@/components/AskPaSheet";
import { AssessmentSection } from "@/components/AssessmentSection";
import { CustomProviderKeys } from "@/components/CustomProviderKeys";
import { DispatchSettingsSection } from "@/components/DispatchSettingsSection";
import { LoginPasswordSection } from "@/components/LoginPasswordSection";
import { Note } from "@/components/ops/kit";
import { ProviderSettingsSection } from "@/components/ProviderSettingsSection";
import { Page, PageBody, PageHeader } from "@/components/page";
import { SettingsField } from "@/components/SettingsField";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSystemInfo } from "@/features/settings/hooks";
import { RawJsonEditor } from "@/features/settings/RawJsonEditor";
import { isSecretKeyName } from "@/features/settings/settings-json";
import {
  NAV_SECTIONS,
  SETTINGS_SECTIONS,
  type SettingsFieldId,
  type SettingsSection,
  type SettingsSectionId,
  settingsSearch,
} from "@/features/settings/settings-layout";
import { chooseLocale, currentLocale, localeOptions, t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type SettingsMode = "form" | "raw";

function EnvRow({ k, v }: { k: string; v: string }) {
  const tone = isSecretKeyName(k) ? "text-(--warn)" : "text-(--body)";
  return (
    <div className="grid gap-0.5 border-b border-(--hairline)/40 py-1.5 font-mono text-xs last:border-b-0 sm:grid-cols-[240px_1fr] sm:gap-2">
      <dt className="wrap-anywhere text-(--mute)">{k}</dt>
      <dd className={`wrap-anywhere tabular-nums ${tone}`}>{v}</dd>
    </div>
  );
}

/** ADR 0079: the interface language. The operator menu offers the same
 *  choice; Settings owns it, because this is where the top-bar avatar sends
 *  people. A switch reloads the page — the dictionary is not reactive. */
function InterfaceLanguageSection() {
  const locale = currentLocale();
  return (
    <SettingsField
      title={t("Language")}
      hint={t("English is the source; the other languages are dictionaries of it.")}
    >
      <div className="flex items-center gap-3">
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
          <SelectTrigger id="ui-language" className="w-44">
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
        <Note>{t("The choice saves at once and reloads the page.")}</Note>
      </div>
    </SettingsField>
  );
}

/** What the backend reports about itself. Read-only. */
function SystemInfoSection() {
  const system = useSystemInfo();
  let body: ReactNode = <p className="text-xs text-(--mute)">{t("Loading…")}</p>;
  if (system.isError) {
    const reason = system.error instanceof Error ? system.error.message : String(system.error);
    body = (
      <p className="text-xs text-(--err)">
        {t("The backend did not answer the system-info request: {reason}", { reason })}
      </p>
    );
  }
  const info = system.data;
  if (info !== undefined) {
    const env = Object.entries(info.env);
    const paths = Object.entries(info.paths);
    body = (
      <div className="space-y-4">
        <div>
          <h4 className="mb-1 text-[10px] uppercase tracking-[0.8px] text-(--faint)">
            {t("Environment")}
          </h4>
          <dl className="rounded-md border border-(--hairline) bg-[#10191d] px-3 py-2">
            {env.length === 0 ? (
              <p className="py-1 text-xs text-(--mute)">{t("No env vars exposed.")}</p>
            ) : (
              env.map(([k, v]) => <EnvRow key={k} k={k} v={v} />)
            )}
          </dl>
        </div>
        <div>
          <h4 className="mb-1 text-[10px] uppercase tracking-[0.8px] text-(--faint)">
            {t("Paths")}
          </h4>
          <dl className="rounded-md border border-(--hairline) bg-[#10191d] px-3 py-2">
            {paths.map(([k, v]) => (
              <EnvRow key={k} k={k} v={v} />
            ))}
          </dl>
        </div>
      </div>
    );
  }

  return (
    <SettingsField
      title={t("System info")}
      hint={t("Environment and paths as the backend reports them.")}
    >
      {body}
    </SettingsField>
  );
}

export default function SettingsPage() {
  const [mode, setMode] = useState<SettingsMode>("form");
  const [active, setActive] = useState<SettingsSectionId>("workspace");
  const [query, setQuery] = useState("");
  // The PA sheet opens with a draft in its input; nothing is sent from here.
  const [ask, setAsk] = useState<AskPaRequest | null>(null);
  const askRequest: AskPaRequest = {
    title: t("Workspace settings"),
    draft: t("Help me review the workspace settings and suggest what to change."),
  };

  const searching = query.trim() !== "";
  const matches = useMemo(() => settingsSearch(query, t), [query]);

  function field(id: SettingsFieldId): boolean {
    const visible = matches.includes(id);
    return visible;
  }

  /** While searching, every section with a matching field shows; otherwise the
   *  active one does, and the folded one follows closed. */
  function shown(section: SettingsSection): boolean {
    if (searching) return section.fields.some((candidate) => matches.includes(candidate.id));
    const folded = section.folded;
    const current = section.id === active;
    return folded || current;
  }

  function jump(id: SettingsSectionId): void {
    setActive(id);
    const element = document.getElementById(`settings-${id}`);
    if (element !== null) element.scrollIntoView({ block: "start" });
  }

  return (
    <Page>
      <PageHeader
        kicker={t("Workspace settings")}
        title={t("Settings")}
        description={t(
          "The common settings first, the complex ones folded. Every form saves where its button says; Raw JSON saves only what you validated.",
        )}
        actions={
          <Button variant="violet" onClick={() => setAsk(askRequest)}>
            {t("Ask the PA")}
          </Button>
        }
      />
      <PageBody className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3.5">
          <div className="relative w-full sm:w-[480px]">
            <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-(--faint)" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("Search name, model, credential, permission…")}
              aria-label={t("Search settings fields")}
              className="h-[52px] rounded-xl pl-10 text-sm"
            />
          </div>
          <div role="group" aria-label={t("Settings mode")} className="flex gap-2">
            <Button
              size="sm"
              variant={mode === "form" ? "default" : "outline"}
              aria-pressed={mode === "form"}
              onClick={() => setMode("form")}
            >
              {t("Form")}
            </Button>
            <Button
              size="sm"
              variant={mode === "raw" ? "default" : "outline"}
              aria-pressed={mode === "raw"}
              onClick={() => setMode("raw")}
            >
              {t("Raw JSON")}
            </Button>
          </div>
        </div>

        {/* Both modes stay mounted and one is hidden, so a staged edit in one
            is not lost by looking at the other. */}
        <div hidden={mode === "raw"} className="grid gap-6 lg:grid-cols-[210px_1fr]">
          <nav aria-label={t("Settings sections")} className="flex flex-wrap gap-2 lg:flex-col">
            {NAV_SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                aria-current={active === section.id ? "true" : undefined}
                onClick={() => jump(section.id)}
                className={cn(
                  "rounded-lg border px-3.5 py-2.5 text-left text-xs font-[550] transition-colors",
                  active === section.id
                    ? "border-[#91e4cf55] bg-[#91e4cf12] text-(--primary)"
                    : "border-(--hairline) text-(--mute) hover:text-(--ink)",
                )}
              >
                {t(section.title)}
              </button>
            ))}
            <Link
              href="/channels"
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                "justify-start text-(--mute)",
              )}
            >
              {t("Channels")}
            </Link>
          </nav>

          <div className="max-w-[680px] space-y-7">
            {SETTINGS_SECTIONS.map((section) => {
              const body = (
                <div className="space-y-[15px]">
                  {section.id === "workspace" && (
                    <>
                      <div hidden={!field("language")}>
                        <InterfaceLanguageSection />
                      </div>
                      <div hidden={!field("password")}>
                        <LoginPasswordSection />
                      </div>
                    </>
                  )}
                  {section.id === "models" && (
                    <>
                      <div hidden={!field("providers")}>
                        <ProviderSettingsSection />
                      </div>
                      <div hidden={!field("customKeys")}>
                        <CustomProviderKeys />
                      </div>
                    </>
                  )}
                  {section.id === "execution" && (
                    <>
                      <div hidden={!field("reuseRoom")}>
                        <DispatchSettingsSection />
                      </div>
                      <div hidden={!field("assessment")}>
                        <AssessmentSection />
                      </div>
                    </>
                  )}
                  {section.id === "system" && field("systemInfo") && <SystemInfoSection />}
                </div>
              );
              const id = `settings-${section.id}`;
              if (section.folded) {
                return (
                  <details
                    key={section.id}
                    id={id}
                    open={searching}
                    hidden={!shown(section)}
                    className="border-t border-(--hairline) py-[18px] text-xs/relaxed text-(--mute)"
                  >
                    <summary className="cursor-pointer text-[13px] text-(--ink)">
                      {t("Advanced · {title}", { title: t(section.title) })}
                    </summary>
                    <div className="mt-4 space-y-4">
                      <p>{t(section.description)}</p>
                      {body}
                    </div>
                  </details>
                );
              }
              return (
                <section
                  key={section.id}
                  id={id}
                  hidden={!shown(section)}
                  className="scroll-mt-4 space-y-[15px]"
                >
                  <h2 className="text-xl font-[550] text-(--ink-strong)">{t(section.title)}</h2>
                  <p className="text-sm/relaxed text-(--mute)">{t(section.description)}</p>
                  {body}
                </section>
              );
            })}
            {searching && matches.length === 0 && (
              <p className="py-[25px] text-sm text-(--mute)">{t("No matching field.")}</p>
            )}
            <Note>
              {t(
                "Each form saves on its own: the dispatch switch and the language choice at once, the others with their Save button. Nothing here saves by itself.",
              )}
            </Note>
          </div>
        </div>

        <div hidden={mode === "form"}>
          <RawJsonEditor />
        </div>
      </PageBody>

      <AskPaSheet request={ask} onClose={() => setAsk(null)} />
    </Page>
  );
}
