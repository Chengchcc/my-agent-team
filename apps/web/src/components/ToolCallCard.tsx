"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function ToolCallCard({
  name,
  input,
}: {
  id?: string;
  name: string;
  input: unknown;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Card className="border-l-4 border-l-blue-500 bg-muted/50 my-2">
      <CardContent className="p-3">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 text-sm cursor-pointer w-full text-left bg-transparent border-0 p-0"
        >
          <Badge variant="outline" className="font-mono text-xs">
            {"🔧"} {name}
          </Badge>
          <span className="text-muted-foreground text-xs">
            {open ? "▾" : "▸"} details
          </span>
        </button>
        {open && (
          <pre className="mt-2 text-xs bg-background rounded p-2 overflow-x-auto max-h-40">
            {JSON.stringify(input, null, 2)}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}
