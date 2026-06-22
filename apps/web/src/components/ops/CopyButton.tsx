"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(label ? `Copied ${label}` : "Copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleCopy}
            aria-label={label ? `Copy ${label}` : "Copy to clipboard"}
          >
            {copied ? <Check size={12} className="text-primary" /> : <Copy size={12} />}
          </Button>
        }
      />
      <TooltipContent>{label ? `Copy ${label}` : "Copy"}</TooltipContent>
    </Tooltip>
  );
}
