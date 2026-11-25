import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "@/lib/utils";

// Look of the design prototype's field input: a darker well with a hairline border and a mint
// focus ring. Shared with `fieldClass` in lib/form-styles.ts; keep the two in step.
const inputClass =
  "h-auto min-h-9 w-full min-w-0 rounded-lg border border-(--hairline) bg-[#14191b] px-3 py-[11px] text-xs text-(--ink) transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-(--ink) placeholder:text-(--faint) focus-visible:border-(--primary) focus-visible:ring-2 focus-visible:ring-(--primary)/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(inputClass, className)}
      {...props}
    />
  );
}

export { Input, inputClass };
