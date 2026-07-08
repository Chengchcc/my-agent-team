"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  useAgentMcpServers,
  useCreateMcpServer,
  useDeleteMcpServer,
  useUpdateMcpServer,
} from "@/features/agents/hooks";
import type { McpServerRow } from "@/lib/api";

function parseArgs(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key) env[key] = value;
    }
  }
  return env;
}

function formatEnv(env?: Record<string, string> | null): string {
  if (!env) return "";
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function McpForm({
  editing,
  onSubmit,
  onCancel,
}: {
  editing: McpServerRow | null;
  onSubmit: (body: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [transport, setTransport] = useState<"stdio" | "sse">(
    editing?.transport ?? "stdio",
  );
  const [command, setCommand] = useState(editing?.command ?? "");
  const [args, setArgs] = useState(
    editing?.args ? editing.args.join(", ") : "",
  );
  const [env, setEnv] = useState(formatEnv(editing?.env));
  const [url, setUrl] = useState(editing?.url ?? "");
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      name,
      transport,
      enabled,
    };
    if (transport === "stdio") {
      body.command = command;
      body.args = parseArgs(args);
      body.env = parseEnv(env);
    } else {
      body.url = url;
    }
    if (editing) {
      body.serverId = editing.serverId;
    }
    onSubmit(body);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="mcp-name">Name</Label>
        <Input
          id="mcp-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="mcp-transport">Transport</Label>
        <Select
          value={transport}
          onValueChange={(v) => setTransport(v as "stdio" | "sse")}
        >
          <SelectTrigger id="mcp-transport" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stdio">stdio</SelectItem>
            <SelectItem value="sse">sse</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {transport === "stdio" ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="mcp-command">Command</Label>
            <Input
              id="mcp-command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="e.g. npx -y @modelcontextprotocol/server-filesystem"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-args">Args (comma-separated)</Label>
            <Textarea
              id="mcp-args"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="e.g. /path/to/dir, --flag"
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-env">Env (KEY=VALUE, one per line)</Label>
            <Textarea
              id="mcp-env"
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              placeholder="MY_VAR=value"
              rows={3}
            />
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="mcp-url">URL</Label>
          <Input
            id="mcp-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/sse"
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          id="mcp-enabled"
        />
        <Label htmlFor="mcp-enabled">Enabled</Label>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </DialogFooter>
    </form>
  );
}

export function McpServerPanel({ agentId }: { agentId: string }) {
  const { data, isLoading } = useAgentMcpServers(agentId);
  const createMu = useCreateMcpServer(agentId);
  const updateMu = useUpdateMcpServer(agentId);
  const deleteMu = useDeleteMcpServer(agentId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerRow | null>(null);

  function openAdd() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(server: McpServerRow) {
    setEditing(server);
    setDialogOpen(true);
  }

  function handleSubmit(body: Record<string, unknown>) {
    if (editing) {
      updateMu.mutate(
        body as { serverId: string } & Parameters<typeof updateMu.mutate>[0],
        { onSuccess: () => setDialogOpen(false) },
      );
    } else {
      createMu.mutate(
        body as Parameters<typeof createMu.mutate>[0],
        { onSuccess: () => setDialogOpen(false) },
      );
    }
  }

  const servers = data?.mcpServers ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">MCP Servers</h3>
        <Button size="sm" onClick={openAdd}>
          Add MCP Server
        </Button>
      </div>

      {isLoading && (
        <div className="animate-pulse space-y-3">
          <div className="h-16 rounded-xl bg-[var(--canvas-soft)]" />
          <div className="h-16 rounded-xl bg-[var(--canvas-soft)]" />
        </div>
      )}

      {!isLoading && servers.length === 0 && (
        <p className="text-sm text-[var(--mute)]">
          No MCP servers configured. Add one to extend this agent&apos;s
          capabilities.
        </p>
      )}

      {!isLoading &&
        servers.map((server) => (
          <Card key={server.serverId} size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {server.name}
                <Badge
                  variant={
                    server.transport === "stdio" ? "secondary" : "outline"
                  }
                >
                  {server.transport}
                </Badge>
                {server.enabled ? (
                  <Badge variant="default" className="text-xs">
                    enabled
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs">
                    disabled
                  </Badge>
                )}
              </CardTitle>
              {server.transport === "stdio" && server.command && (
                <CardDescription>
                  {server.command}
                  {server.args && server.args.length > 0
                    ? ` ${server.args.join(" ")}`
                    : ""}
                </CardDescription>
              )}
              {server.transport === "sse" && server.url && (
                <CardDescription>{server.url}</CardDescription>
              )}
            </CardHeader>
            <CardContent className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openEdit(server)}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={() => {
                  if (confirm("Delete this MCP server?"))
                    deleteMu.mutate(server.serverId);
                }}
              >
                Delete
              </Button>
            </CardContent>
          </Card>
        ))}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit" : "Add"} MCP Server
            </DialogTitle>
          </DialogHeader>
          <McpForm
            editing={editing}
            onSubmit={handleSubmit}
            onCancel={() => setDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
