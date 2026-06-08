"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function AgentForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [baseURL, setBaseURL] = useState("");
  const [permissionMode, setPermissionMode] = useState<
    "ask" | "auto" | "deny"
  >("ask");
  const [maxSteps, setMaxSteps] = useState("");
  const [template, setTemplate] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const agent = await api.createAgent({
        name,
        model: {
          provider: "anthropic",
          model,
          ...(baseURL ? { baseURL } : {}),
        },
        permissionMode,
        ...(maxSteps ? { maxSteps: parseInt(maxSteps, 10) } : {}),
        ...(template ? { template } : {}),
      });
      setOpen(false);
      router.push(`/agents/${agent.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
        Create Agent
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Create Agent</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-sm font-medium">Name *</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Agent name"
              required
              minLength={1}
            />
          </div>
          <div>
            <label className="text-sm font-medium">Provider</label>
            <Select value="anthropic" disabled>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="anthropic">Anthropic</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Only Anthropic supported currently
            </p>
          </div>
          <div>
            <label className="text-sm font-medium">Model *</label>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="claude-sonnet-4-6"
              required
            />
          </div>
          <div>
            <label className="text-sm font-medium">Base URL</label>
            <Input
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="https://api.anthropic.com/v1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Permission Mode</label>
            <Select
              value={permissionMode}
              onValueChange={(v) =>
                setPermissionMode(v as "ask" | "auto" | "deny")
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask">
                  Ask (approval required — M8.5)
                </SelectItem>
                <SelectItem value="auto">Auto (always approve)</SelectItem>
                <SelectItem value="deny">Deny (always deny)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Approval enforcement coming in M8.5; currently decorative
            </p>
          </div>
          <div>
            <label className="text-sm font-medium">Max Steps</label>
            <Input
              type="number"
              value={maxSteps}
              onChange={(e) => setMaxSteps(e.target.value)}
              placeholder="Unlimited"
              min={1}
            />
          </div>
          <div>
            <label className="text-sm font-medium">Template</label>
            <Input
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder="Template name (optional)"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button
            type="submit"
            disabled={submitting || !name.trim()}
            className="w-full"
          >
            {submitting ? "Creating..." : "Create Agent"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
