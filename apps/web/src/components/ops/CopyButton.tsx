"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

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
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={handleCopy}
      title={label ? `Copy ${label}` : "Copy"}
      aria-label={label ? `Copy ${label}` : "Copy to clipboard"}
    >
      {copied ? <Check size={12} className="text-primary" /> : <Copy size={12} />}
    </Button>
  );
}
