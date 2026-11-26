import type { ReactNode } from "react";

/** One settings field as the prototype draws it: a bordered card on the
 *  section's darker ground, a title with an optional status beside it, the
 *  hint under it, the control last. */
export function SettingsField({
  title,
  hint,
  aside,
  children,
}: {
  title: string;
  hint?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-[15px] rounded-[13px] border border-white/6 bg-[#162025] px-[22px] py-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-[550] text-(--ink-strong)">{title}</h3>
        {aside}
      </div>
      {hint !== undefined && <div className="text-xs/relaxed text-(--mute)">{hint}</div>}
      <div className="space-y-3">{children}</div>
    </div>
  );
}
