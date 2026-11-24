import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Page, PageBody, PageHeader } from "@/components/page";
import { buttonVariants } from "@/components/ui/button";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { serverLocale, serverT } from "@/lib/i18n.server";

/** A missing address keeps the console: the shell, a way back. Next's default
 *  page is a white "404" with neither (measured by a review, 2026-11-24). The
 *  root layout has no shell of its own, so this one brings it. */
export default async function NotFound() {
  const [locale, t] = await Promise.all([serverLocale(), serverT()]);
  return (
    // The (main) layout provides these around the shell; the root has none,
    // and the shell's sidebar throws without its provider (the build said so).
    <TooltipProvider delay={500}>
      <SidebarProvider>
        <AppShell locale={locale}>
          <Page>
            <PageHeader title={t("Not found")} description={t("Nothing lives at this address.")} />
            <PageBody>
              <Link href="/today" className={buttonVariants({ variant: "outline", size: "sm" })}>
                {t("Back to Today")}
              </Link>
            </PageBody>
          </Page>
        </AppShell>
      </SidebarProvider>
    </TooltipProvider>
  );
}
