import type { ReactNode } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Shared page skeleton. One grammar for every top-level page:
 *  PageHeader (border-bottom, title/description/action) + PageBody
 *  (responsive padding; wide = max-w-7xl, reading = max-w-3xl). */
export function Page({ children }: { children: ReactNode }) {
  return <div className="min-h-full">{children}</div>;
}

/** One breadcrumb grammar: a string renders one crumb; a structured
 *  trail renders link ancestors + a terminal BreadcrumbPage, separated by
 *  the shared separator. ReactNode passes through untouched. */
/** Breadcrumb text is shell vocabulary ("Work / Workflows"), so every segment
 *  goes through the dictionary; an unknown segment stays as written. */
function shellText(text: string): string {
  return text
    .split(" / ")
    .map((segment) => t(segment))
    .join(" / ");
}

function renderBreadcrumb(
  bc: ReactNode | string | ReadonlyArray<{ label: string; href?: string }>,
): ReactNode {
  if (typeof bc === "string") {
    return (
      <BreadcrumbItem>
        <BreadcrumbPage>{shellText(bc)}</BreadcrumbPage>
      </BreadcrumbItem>
    );
  }
  if (Array.isArray(bc)) {
    return bc.flatMap((c, i): ReactNode[] => {
      const last = i === bc.length - 1;
      const item = (
        <BreadcrumbItem key={`${c.label}-${i}`}>
          {c.href && !last ? (
            <BreadcrumbLink href={c.href}>{shellText(c.label)}</BreadcrumbLink>
          ) : (
            <BreadcrumbPage>{shellText(c.label)}</BreadcrumbPage>
          )}
        </BreadcrumbItem>
      );
      // Separator is itself an <li> — it must be a SIBLING of the item
      // inside the <ol>, never a child (li-in-li hydration error).
      return last ? [item] : [item, <BreadcrumbSeparator key={`${c.label}-${i}-sep`} />];
    });
  }
  return (
    <BreadcrumbItem>
      <BreadcrumbPage>{bc as ReactNode}</BreadcrumbPage>
    </BreadcrumbItem>
  );
}

export function PageHeader({
  breadcrumb,
  title,
  pill,
  kicker,
  subtitle,
  description,
  action,
  actions,
}: {
  /** Breadcrumb: ReactNode (full control), plain string (single crumb), or
   *  a structured trail — ancestors get links, the last crumb is the
   *  current page. Renders through the one shared ui/breadcrumb grammar. */
  breadcrumb?: ReactNode | string | ReadonlyArray<{ label: string; href?: string }>;
  title: string;
  /** Small status chip rendered inline after the title. */
  pill?: ReactNode;
  kicker?: string;
  subtitle?: string;
  /** Legacy single action (kept for existing callers). */
  description?: string;
  action?: ReactNode;
  /** Action cluster, right-aligned: ghost -> outline -> primary, gap 8. */
  actions?: ReactNode;
}) {
  let line = description;
  if (subtitle !== undefined) line = subtitle;
  return (
    <div className="mb-[29px] px-4 sm:px-6 lg:px-8">
      {breadcrumb != null && (
        <Breadcrumb className="mb-2">
          <BreadcrumbList>{renderBreadcrumb(breadcrumb)}</BreadcrumbList>
        </Breadcrumb>
      )}
      <div className="flex flex-wrap items-center justify-between gap-5">
        <div className="min-w-0">
          {kicker && (
            <p className="text-[10px] tracking-[1.8px] uppercase text-(--faint)">{t(kicker)}</p>
          )}
          <div className="flex items-center gap-2.5">
            <h1 className="text-[29px] leading-[1.4] font-[550] tracking-[-1px] text-(--ink)">
              {t(title)}
            </h1>
            {pill}
          </div>
          {line && <p className="mt-0.5 text-xs text-(--mute)">{t(line)}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">{actions ?? action}</div>
      </div>
    </div>
  );
}

export function PageBody({
  size = "wide",
  className,
  children,
}: {
  size?: "wide" | "reading";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "px-4 sm:px-6 lg:px-8 pb-6 ",
        size === "wide" ? "" : "mx-auto max-w-3xl",
        className,
      )}
    >
      {children}
    </div>
  );
}
