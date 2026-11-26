import type * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-(--hairline) bg-[#14191b] px-3 py-[11px] text-xs/relaxed  text-(--ink) transition-colors outline-none placeholder:text-(--faint) focus-visible:border-(--primary) focus-visible:ring-2 focus-visible:ring-(--primary)/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
