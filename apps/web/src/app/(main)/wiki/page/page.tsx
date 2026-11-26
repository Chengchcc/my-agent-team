"use client";

import { MessageCircle } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { type AskPaRequest, AskPaSheet } from "@/components/AskPaSheet";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import {
  askAboutWikiPageRequest,
  formatWikiDay,
  WikiArticleContent,
  wikiStatusBadge,
} from "@/components/wiki/WikiReaderSheet";
import { useAgentList } from "@/features/agents/hooks";
import { isWikiPage, useWikiPage } from "@/features/wiki/hooks";
import { t } from "@/lib/i18n";

/** ADR 0074 S3/S5: one page, for reading. Who keeps it and where its claims come from are said
 *  under the title; the body is 16px inside a bounded line; the table of contents, the pages it
 *  leads to, and a collapsible area for sources, backlinks, versions and the graph sit beside it.
 *
 *  Read-only. A question about the page goes to the PA as a draft the person sends. */
export default function WikiPageView() {
  const rawParams = useSearchParams();
  const path = rawParams === null ? null : rawParams.get("path");
  const pageQuery = useWikiPage(path);
  const { data: agents } = useAgentList();
  const [ask, setAsk] = useState<AskPaRequest | null>(null);

  const page = pageQuery.data;
  const body = isWikiPage(page) ? page : null;

  const agentNameById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );

  function maintainer(id: string): string {
    const name = agentNameById.get(id);
    if (name === undefined) return id;
    return `${name} (${id})`;
  }

  if (path === null) {
    return (
      <Page>
        <PageHeader
          breadcrumb={[{ label: "Wiki", href: "/wiki" }]}
          title="Wiki"
          description="No page selected."
        />
        <PageBody size="reading">
          <Link href="/wiki" className="text-sm text-(--primary) hover:text-(--primary-deep)">
            {t("Back to the index")}
          </Link>
        </PageBody>
      </Page>
    );
  }

  if (body === null) {
    const missing = !pageQuery.isLoading && pageQuery.data !== undefined;
    return (
      <Page>
        <PageHeader
          breadcrumb={[{ label: "Wiki", href: "/wiki" }]}
          title="Wiki"
          description={missing ? t("This page does not exist or cannot be read.") : t("Loading…")}
        />
        <PageBody size="reading">
          <Link href="/wiki" className="text-sm text-(--primary) hover:text-(--primary-deep)">
            {t("Back to the index")}
          </Link>
        </PageBody>
      </Page>
    );
  }

  const fm = body.frontmatter;
  const keeper = maintainer(fm.maintainedBy);

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Wiki", href: "/wiki" }, { label: "Page" }]}
        title={fm.title}
        pill={wikiStatusBadge(fm.status)}
        description={t("Maintained by {name} · updated {day}", {
          name: keeper,
          day: formatWikiDay(fm.updated),
        })}
        actions={
          <Button onClick={() => setAsk(askAboutWikiPageRequest(fm.title, body.path))}>
            <MessageCircle /> {t("Ask the PA about this page")}
          </Button>
        }
      />
      <PageBody>
        <WikiArticleContent path={path} />
      </PageBody>

      <AskPaSheet request={ask} onClose={() => setAsk(null)} />
    </Page>
  );
}
