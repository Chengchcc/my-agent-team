import type { VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { Badge, type badgeVariants } from "@/components/ui/badge";
import { t } from "@/lib/i18n";
import type { StatusLook, StatusTone } from "@/lib/status";
import { cn } from "@/lib/utils";

type PillVariant = "default" | "secondary" | "destructive" | "wait";

/** The status vocabulary's tone, as the pill's variant. `wait` (amber) is the
 *  one tone the shared `badgeVariantFor` folds into neutral. */
function pillVariant(tone: StatusTone): PillVariant {
  if (tone === "err") return "destructive";
  if (tone === "warn") return "wait";
  if (tone === "muted") return "secondary";
  return "default";
}

/** One state as one pill: the vocabulary's shape and word, in its tone. The
 *  shape keeps the state readable without the colour. */
export function StatusBadge({ look, className }: { look: StatusLook; className?: string }) {
  return (
    <Badge variant={pillVariant(look.tone)} className={cn("font-mono", className)}>
      <span aria-hidden="true">{look.shape}</span>
      {t(look.label)}
    </Badge>
  );
}

/** The tone of a fact stated outside the status vocabulary — a pack's materialization, a
 *  connection test. The page picks the tone; this picks the pill, so every page states a tone
 *  the same way. */
export type FactTone = "ok" | "warn" | "err" | "muted";

export type FactBadgeVariant = VariantProps<typeof badgeVariants>["variant"];

export function badgeVariantOfTone(tone: FactTone): FactBadgeVariant {
  return pillVariant(tone);
}

/** A line of the prototype's table panels. Wide screens see a table; below
 *  `md` each row stacks and every cell carries its column name, so nothing
 *  scrolls sideways on a phone. */
const ROW_CLASS = "block w-full border-b border-(--hairline) last:border-b-0 md:table-row";
const CELL_CLASS =
  "block px-4 py-1.5 first:pt-3 last:pb-3 align-top [overflow-wrap:anywhere] md:table-cell md:px-3 md:py-3";
const CELL_LABEL_CLASS =
  "before:mr-2 before:font-mono before:text-[9px] before:tracking-[0.8px] before:uppercase before:text-(--faint) before:content-[attr(data-label)] md:before:hidden";

export function PanelTable({
  columns,
  label,
  className,
  children,
}: {
  columns: readonly ReactNode[];
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("rounded-2xl border border-white/6 bg-(--panel) wrap-anywhere", className)}>
      <table className="w-full border-collapse text-left text-[11px]" aria-label={label}>
        <thead className="hidden md:table-header-group">
          <tr>
            {columns.map((column, index) => (
              <th
                key={index}
                scope="col"
                className="whitespace-nowrap border-b border-(--hairline) p-3  text-[10px] font-normal tracking-[0.8px] uppercase text-(--mute)"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="block md:table-row-group">{children}</tbody>
      </table>
    </div>
  );
}

export function PanelRow({ children, className }: { children: ReactNode; className?: string }) {
  return <tr className={cn(ROW_CLASS, className)}>{children}</tr>;
}

export function PanelCell({
  label,
  className,
  children,
}: {
  /** The column's name; shown beside the value on narrow screens. */
  label: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <td data-label={label} className={cn(CELL_CLASS, CELL_LABEL_CLASS, className)}>
      {children}
    </td>
  );
}

/** The prototype's note line: the least prominent text on the page. */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-[10px]/relaxed  text-(--faint)", className)}>{children}</p>;
}
