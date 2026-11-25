import { cn } from "@/lib/utils";

export type RoleKind = "pa" | "worker" | "reviewer" | "research" | "user";

const ROLE_CLASS: Record<RoleKind, string> = {
  pa: "bg-[rgb(48,48,64)] text-(--accent-violet) border-[rgba(184,165,237,0.157)]",
  worker: "bg-[rgb(39,58,51)] text-(--primary) border-[rgba(180,241,209,0.106)]",
  reviewer: "bg-[rgb(59,50,41)] text-(--warn) border-[rgba(237,196,140,0.145)]",
  research: "bg-[rgb(37,54,65)] text-[rgb(157,203,236)] border-[rgba(157,203,236,0.145)]",
  user: "bg-[rgb(48,54,58)] text-[rgb(212,218,221)] border-[rgba(255,255,255,0.082)]",
};

const SIZE_CLASS: Record<"default" | "sm" | "lg", string> = {
  default: "size-[34px] rounded-[11px] text-xs",
  sm: "size-[30px] rounded-[10px] text-[10px]",
  lg: "size-12 rounded-[14px] text-[17px]",
};

/** A member's mark as the design prototype draws it: a rounded square in the colour of its role,
 *  carrying the initial. Presentation only — it grants nothing and decides nothing. */
export function RoleAvatar({
  kind,
  name,
  size = "default",
  className,
}: {
  kind: RoleKind;
  name: string;
  size?: "default" | "sm" | "lg";
  className?: string;
}) {
  const initial = name.trim().charAt(0).toUpperCase();
  return (
    <span
      data-slot="role-avatar"
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center border font-[650]",
        SIZE_CLASS[size],
        ROLE_CLASS[kind],
        className,
      )}
    >
      {initial}
    </span>
  );
}

/** Which mark a member gets. A front (a PA) is violet; a worker is mint, amber when it reviews,
 *  blue when it researches (read off its name, as the prototype's seed members are named). */
export function roleKindOf(member: { name: string; role?: string | null }): RoleKind {
  if (member.role !== "worker") return "pa";
  if (/review/i.test(member.name)) return "reviewer";
  if (/research/i.test(member.name)) return "research";
  return "worker";
}
