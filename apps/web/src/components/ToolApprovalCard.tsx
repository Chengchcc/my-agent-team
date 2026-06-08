"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface ToolApprovalCardProps {
  tool: { id: string; name: string; input: unknown };
  onApprove: (message?: string) => void;
  onDeny: (message?: string) => void;
  disabled?: boolean;
}

export function ToolApprovalCard({
  tool,
  onApprove,
  onDeny,
  disabled,
}: ToolApprovalCardProps) {
  const [message, setMessage] = useState("");

  return (
    <Card className="border-2 border-yellow-500 rounded-none border-x-0">
      <CardContent className="p-4">
        <p className="text-sm font-medium mb-2">
          Agent wants to use{" "}
          <span className="font-mono bg-muted px-1 rounded">
            {tool.name}
          </span>
        </p>
        <pre className="text-xs bg-muted rounded p-2 mb-3 max-h-24 overflow-y-auto">
          {JSON.stringify(tool.input, null, 2)}
        </pre>
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Optional feedback message..."
          className="mb-3 text-sm"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => onApprove(message || undefined)}
            disabled={disabled}
          >
            Approve
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => onDeny(message || undefined)}
            disabled={disabled}
          >
            Deny
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
