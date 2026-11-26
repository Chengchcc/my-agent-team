import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Look of the design prototype's `.pill`: a 10px label in a 5px-radius chip; the variant is the
// state it names (live/done = mint, wait = amber, fail = danger, neutral = muted).
const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-sm border px-2 py-[5px] text-[10px] leading-[1.3] whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "border-[rgba(180,241,209,0.09)] bg-[rgba(180,241,209,0.047)] text-(--primary)",
        secondary: "border-white/[0.035] bg-white/[0.016] text-(--mute)",
        destructive:
          "border-[rgba(239,164,158,0.106)] bg-[rgba(239,164,158,0.043)] text-(--err) focus-visible:ring-destructive/20",
        wait: "border-[rgba(237,196,140,0.11)] bg-[rgba(237,196,140,0.047)] text-(--warn)",
        outline: "border-(--hairline) text-(--ink)",
        ghost: "text-(--mute) hover:bg-white/[0.047] hover:text-(--ink)",
        link: "text-(--primary) underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge, badgeVariants };
