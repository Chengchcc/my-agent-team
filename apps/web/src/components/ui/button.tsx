import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Look of the design prototype's `.btn`: 12px / 550, 8px radius, a hairline border on the
// neutral ground, mint for the one primary action.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-transparent bg-clip-padding text-xs font-[550] whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border-(--primary) bg-(--primary) text-(--on-primary) shadow-[0_3px_16px_rgba(180,241,209,0.047)] hover:bg-[rgb(201,248,223)]",
        outline:
          "border-(--hairline) bg-white/1 text-(--ink) hover:bg-white/[0.047] aria-expanded:bg-white/[0.047]",
        secondary:
          "border-white/[0.035] bg-white/[0.016] text-(--mute) hover:bg-white/[0.047] hover:text-(--ink) aria-expanded:bg-white/[0.047]",
        ghost: "text-(--body) hover:bg-white/3 hover:text-(--ink) aria-expanded:bg-white/3",
        destructive:
          "border-destructive/20 bg-transparent text-(--err) hover:bg-destructive/10 focus-visible:ring-(--err)/20",
        violet:
          "border-[rgba(184,165,237,0.19)] bg-[rgba(184,165,237,0.07)] text-[rgb(208,195,244)] hover:bg-[rgba(184,165,237,0.12)]",
        link: "text-(--primary) underline-offset-4 hover:text-(--primary-deep) hover:underline",
      },
      size: {
        default: "min-h-[38px] px-[15px] py-2.5",
        xs: "h-6 gap-1 rounded-md px-2 text-[11px] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "min-h-8 px-[11px] py-1.5 text-[11px] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "min-h-10 px-5",
        icon: "size-9 text-(--mute) hover:bg-white/3 hover:text-(--ink)",
        "icon-xs":
          "size-6 rounded-md text-(--mute) hover:bg-white/3 hover:text-(--ink) in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-md text-(--mute) hover:bg-white/3 hover:text-(--ink) in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-10 rounded-lg text-(--mute) hover:bg-white/3 hover:text-(--ink)",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
    compoundVariants: [{ variant: "link", class: "min-h-0 p-0" }],
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  nativeButton,
  render,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  // A button rendered as something else (a link, a span) is not a native <button>. Saying so
  // here, once, keeps every call site from repeating it — and Base UI from logging an error.
  const isNative = nativeButton ?? render === undefined;
  return (
    <ButtonPrimitive
      data-slot="button"
      nativeButton={isNative}
      render={render}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
