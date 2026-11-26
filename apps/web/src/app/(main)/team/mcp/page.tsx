"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Plug, Plus } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { type AskPaRequest, AskPaSheet } from "@/components/AskPaSheet";
import {
  badgeVariantOfTone as badgeOf,
  Note,
  PanelCell,
  PanelRow,
  PanelTable,
  type FactTone as Tone,
} from "@/components/ops/kit";
import { QueryState } from "@/components/ops/QueryState";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResourceEditorSheet } from "@/components/ui/resource-editor-sheet";
import { RoleAvatar, roleKindOf } from "@/components/ui/role-avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetFooter, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useAgentList } from "@/features/agents/hooks";
import { bindChanges, bindingOf } from "@/features/mcp/bindings";
import { mcpFacts } from "@/features/mcp/facts";
import {
  useCreateMcpServer,
  useDeleteMcpServer,
  useInvokeMcpTool,
  useMcpCatalog,
  useMcpToolCatalog,
  useRestartMcpServer,
  useSetAgentMcpServers,
  useTestMcpConnection,
  useUpdateMcpServer,
} from "@/features/mcp/hooks";
import type { McpCatalogRow } from "@/features/mcp/queries";
import {
  createSettingsFrom,
  EMPTY_FORM,
  formFromServer,
  type ServerForm,
  serversFromJson,
  updateSettingsFrom,
} from "@/features/mcp/server-form";
import type {
  ConnectionState,
  ToolCallOutcome,
  ToolCatalog,
  ToolParameter,
} from "@/features/mcp/tool-catalog";
import type { AgentRow } from "@/lib/api";
import { t } from "@/lib/i18n";

/** MCP connections (ADR 0022). Four facts are stated apart and never one another's stand-in:
 *  the catalog (only after discovery), the backend's own connection probe, the latest agent
 *  runtime mount, the stored secrets. Discovery, a connection test and a test call are three
 *  separate actions. Secrets are write-only: the server answers masked, so an edit sends a
 *  secret map only when the person typed one. */

const CONNECTION: Record<ConnectionState, { label: string; tone: Tone }> = {
  "never tested": { label: "Not tested", tone: "muted" },
  connecting: { label: "Connecting", tone: "warn" },
  connected: { label: "Connected", tone: "ok" },
  failed: { label: "Failed", tone: "err" },
};

/** One fact as its own pill: the fact's name, then its state in that state's tone. */
function Fact({
  name,
  state,
  tone = "muted",
  title,
}: {
  name: string;
  state: string;
  tone?: Tone;
  title?: string;
}) {
  return (
    <Badge variant={badgeOf(tone)} title={title} className="font-normal">
      <span className="text-(--faint)">{t(name)} ·</span> {t(state)}
    </Badge>
  );
}

function secretsText(facts: { env: number; headers: number }): string {
  if (facts.env === 0 && facts.headers === 0) return "none stored";
  return `${facts.env} env, ${facts.headers} header`;
}

function Callout({ children }: { children: ReactNode }) {
  return (
    <p className="mb-4 flex gap-2.5 rounded-[9px] border border-[rgba(237,196,140,.11)] bg-[rgba(237,196,140,.03)] px-[15px] py-[13px] text-[11px] text-(--warn)">
      {children}
    </p>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label className="text-[11px] font-normal text-(--mute)">{label}</Label>
      {children}
      {hint !== undefined && <Note>{hint}</Note>}
    </div>
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ── Card ────────────────────────────────────────────────────────────────────────

function ServerCard({
  server,
  members,
  onDetail,
  onEdit,
  onTest,
  onBind,
  onRestart,
  onDelete,
}: {
  server: McpCatalogRow;
  members: AgentRow[];
  onDetail: () => void;
  onEdit: () => void;
  onTest: () => void;
  onBind: () => void;
  onRestart: () => void;
  onDelete: () => void;
}) {
  const catalog = useMcpToolCatalog(server.serverId);
  const facts = mcpFacts(server, catalog.data);
  const bound = members.filter((m) => bindingOf(m, server.serverId) !== "none").length;
  const address =
    server.transport === "sse" ? server.url : [server.command, ...(server.args ?? [])].join(" ");
  const discovery = catalog.data === undefined ? "Not discovered" : `${facts.catalog.count} tools`;
  const connection = CONNECTION[facts.connection];

  function runtimeFact(): ReactNode {
    if (facts.runtime === null) return null;
    const failed = facts.runtime.status === "failed";
    return (
      <Fact
        name="Agent runtime"
        state={failed ? "failed to mount" : `${facts.runtime.toolsCount} tools mounted`}
        tone={failed ? "err" : "ok"}
        title={t(
          "The latest run that mounted this server reported this. It is not the connection test.",
        )}
      />
    );
  }

  return (
    <article className="rounded-2xl border border-white/6 bg-(--panel) p-5">
      <p className="text-[10px] tracking-[1.8px] uppercase text-(--faint)">
        {t(server.transport === "sse" ? "HTTP" : "stdio")} · {t("SERVER")}
      </p>
      <h2 className="mt-1.5 text-sm font-[550] text-(--ink)">{server.name}</h2>
      <p className="truncate font-mono text-[11px] text-(--mute)">
        {address === "" ? "—" : address}
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Fact name="Catalog" state={discovery} tone={catalog.data === undefined ? "muted" : "ok"} />
        <Fact name="Connection" state={connection.label} tone={connection.tone} />
        <Fact
          name="Secrets"
          state={secretsText(facts.secrets)}
          title={t("How many values are stored. Their content is never shown.")}
        />
        <Fact
          name="Members"
          state={t("{count} bound", { count: bound })}
          tone={bound > 0 ? "ok" : "muted"}
        />
        {runtimeFact()}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={onDetail}>
          {t("View tool catalog")}
        </Button>
        <Button size="sm" variant="outline" onClick={onEdit}>
          {t("Edit")}
        </Button>
        <Button size="sm" variant="outline" onClick={onTest}>
          {t("Test connection")}
        </Button>
        <Button size="sm" variant="outline" onClick={onBind}>
          {t("Bind members")}
        </Button>
        <Button size="sm" variant="outline" onClick={onRestart}>
          {t("Restart")}
        </Button>
        <Button size="sm" variant="destructive" onClick={onDelete}>
          {t("Delete")}
        </Button>
      </div>
    </article>
  );
}

// ── Tool panel (detail, right) ─────────────────────────────────────────────────

function ToolPanel({
  serverId,
  catalog,
  tool,
}: {
  serverId: string;
  catalog: ToolCatalog;
  tool: ToolCatalog["tools"][number];
}) {
  const { confirm, dialog } = useConfirm();
  const invoke = useInvokeMcpTool();
  const [args, setArgs] = useState("{}");
  const [outcome, setOutcome] = useState<ToolCallOutcome | null>(null);

  async function testCall(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args === "" ? "{}" : args);
    } catch {
      setOutcome({ ok: false, text: t("Arguments must be a JSON object.") });
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setOutcome({ ok: false, text: t("Arguments must be a JSON object.") });
      return;
    }
    const go = await confirm({
      title: t("Call {tool} now?", { tool: tool.name }),
      description: t(
        "It runs once with your login only. It is neither approved nor audited, and its result is not kept.",
      ),
      confirmText: t("Run the call"),
    });
    if (!go) return;
    setOutcome(null);
    try {
      setOutcome(
        await invoke.mutateAsync({
          serverId,
          tool: tool.name,
          args: parsed as Record<string, unknown>,
        }),
      );
    } catch (error) {
      setOutcome({ ok: false, text: errorText(error) });
    }
  }

  return (
    <div className="space-y-4">
      <h3 className="break-all font-mono text-sm text-(--ink)">{tool.name}</h3>
      {tool.description === "" ? (
        <Note>{t("No description")}</Note>
      ) : (
        <p className="text-xs/relaxed  text-(--body)">{tool.description}</p>
      )}
      <ParameterTable parameters={tool.parameters} />
      <details>
        <summary className="cursor-pointer font-mono text-[10px] text-(--mute)">
          inputSchema · JSON
        </summary>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-(--canvas) p-3 font-mono text-[10px] text-(--body)">
          {JSON.stringify(tool.inputSchema, null, 2)}
        </pre>
      </details>
      <div className="space-y-2 border-t border-(--hairline) pt-4">
        <p className="text-[10px] tracking-[1.8px] uppercase text-(--faint)">{t("Test call")}</p>
        <Textarea
          aria-label={t("Arguments JSON")}
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          rows={3}
          className="font-mono text-[11px]"
        />
        <Note>
          {t(
            "A test call runs the tool once, with your login only. It is neither approved nor audited.",
          )}
        </Note>
        <Button
          size="sm"
          variant="outline"
          disabled={invoke.isPending}
          onClick={() => void testCall()}
        >
          {invoke.isPending ? t("Calling…") : t("Test call")}
        </Button>
        {outcome !== null && (
          <pre
            className={`overflow-x-auto rounded-lg border p-3 font-mono text-[11px] ${
              outcome.ok
                ? "border-white/6 bg-(--canvas) text-(--body)"
                : "border-(--err)/20 bg-(--err)/5 text-(--err)"
            }`}
          >
            {t(outcome.ok ? "Result" : "The call failed")}
            {"\n"}
            {outcome.text}
          </pre>
        )}
      </div>
      {catalog.tools.length > 1 && (
        <p className="sr-only">
          {t("{count} tools in this catalog", { count: catalog.tools.length })}
        </p>
      )}
      {dialog}
    </div>
  );
}

function ParameterTable({ parameters }: { parameters: ToolParameter[] }) {
  if (parameters.length === 0) {
    return <Note>{t("The schema lists no parameters.")}</Note>;
  }
  return (
    <PanelTable
      label={t("Parameters")}
      columns={[t("Name"), t("Type"), t("Required"), t("Description")]}
    >
      {parameters.map((parameter) => (
        <PanelRow key={parameter.name}>
          <PanelCell label={t("Name")} className="font-mono text-(--ink)">
            {parameter.name}
          </PanelCell>
          <PanelCell label={t("Type")} className="font-mono">
            {parameter.type}
          </PanelCell>
          <PanelCell label={t("Required")}>
            {t(parameter.required ? "required" : "optional")}
          </PanelCell>
          <PanelCell label={t("Description")} className="text-(--mute)">
            {parameter.description}
          </PanelCell>
        </PanelRow>
      ))}
    </PanelTable>
  );
}

function discoverLabel(busy: boolean, discovered: boolean): string {
  if (busy) return t("Connecting…");
  if (discovered) return t("Discover again");
  return t("Discover tools");
}

// ── Detail sheet ───────────────────────────────────────────────────────────────

function ServerSheet({
  server,
  members,
  onClose,
  onEdit,
  onTest,
  onBind,
  onRestart,
  onDelete,
}: {
  server: McpCatalogRow;
  members: AgentRow[];
  onClose: () => void;
  onEdit: () => void;
  onTest: () => void;
  onBind: () => void;
  onRestart: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const catalog = useMcpToolCatalog(server.serverId);
  const [busy, setBusy] = useState<"restart" | "delete" | "idle">("idle");
  const [selected, setSelected] = useState<string | null>(null);
  const facts = mcpFacts(server, catalog.data);
  const connection = CONNECTION[facts.connection];
  const bound = members.filter((m) => bindingOf(m, server.serverId) !== "none");
  const tool = catalog.data?.tools.find((item) => item.name === selected);

  async function run(action: "restart" | "delete"): Promise<void> {
    setBusy(action);
    try {
      if (action === "restart") await onRestart();
      else await onDelete();
      void catalog.refetch();
    } finally {
      setBusy("idle");
    }
  }

  function discoveryLine(): ReactNode {
    if (catalog.isFetching) return <Fact name="Discovery" state="Connecting" tone="warn" />;
    if (catalog.isError) {
      return (
        <div className="space-y-1">
          <Fact name="Discovery" state="failed" tone="err" />
          <Note>
            {t("The backend could not list the tools: {reason}", {
              reason: errorText(catalog.error),
            })}
          </Note>
        </div>
      );
    }
    const data = catalog.data;
    if (data === undefined) {
      return (
        <div className="space-y-2">
          <Note>
            {t(
              "Not discovered. The list appears only after discovery, which connects to the server.",
            )}
          </Note>
        </div>
      );
    }
    return (
      <Note>
        {t("status {status} · {latency} ms · schema {hash}", {
          status: data.status,
          latency: data.latencyMs === null ? "—" : String(data.latencyMs),
          hash: data.schemaHash === null ? "—" : data.schemaHash.slice(0, 16),
        })}
      </Note>
    );
  }

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        showCloseButton={false}
        className="w-[92vw] max-w-[1200px] gap-0 p-0 sm:max-w-[1200px]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-(--hairline) px-6 py-4">
          <div className="min-w-0">
            <p className="mb-1 text-[10px] tracking-kicker uppercase text-(--mute)">
              {t(server.transport === "sse" ? "HTTP" : "stdio")} · {t("SERVER")}
            </p>
            <SheetTitle className="truncate text-left">{server.name}</SheetTitle>
            <p className="truncate font-mono text-[10px] text-(--faint)">{server.serverId}</p>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label={t("Close")} onClick={onClose}>
            ×
          </Button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[320px_minmax(0,1fr)]">
          <section className="min-h-0 overflow-y-auto border-b border-(--hairline) p-5 md:border-r md:border-b-0">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-[550] text-(--ink)">{t("Tools in this connection")}</h2>
              <Button
                size="sm"
                disabled={catalog.isFetching}
                onClick={() => void catalog.refetch()}
              >
                {discoverLabel(catalog.isFetching, catalog.data !== undefined)}
              </Button>
            </div>
            {discoveryLine()}
            <ul className="mt-3 space-y-1">
              {catalog.data?.tools.map((item) => (
                <li key={item.name}>
                  <Button
                    variant={item.name === selected ? "secondary" : "ghost"}
                    className="w-full justify-start font-mono"
                    onClick={() => setSelected(item.name)}
                  >
                    <span className="truncate">{item.name}</span>
                  </Button>
                </li>
              ))}
              {catalog.data !== undefined && catalog.data.tools.length === 0 && (
                <li>
                  <Note>{t("The server lists no tools.")}</Note>
                </li>
              )}
            </ul>
          </section>
          <section className="min-h-0 overflow-y-auto p-5">
            {tool === undefined ? (
              <div className="space-y-5">
                <div className="flex flex-wrap gap-1.5">
                  <Fact
                    name="Catalog"
                    state={
                      catalog.data === undefined ? "Not discovered" : `${facts.catalog.count} tools`
                    }
                    tone={catalog.data === undefined ? "muted" : "ok"}
                  />
                  <Fact name="Connection" state={connection.label} tone={connection.tone} />
                  <Fact name="Secrets" state={secretsText(facts.secrets)} />
                </div>
                <PanelTable label={t("Connection settings")} columns={[t("Setting"), t("Value")]}>
                  <PanelRow>
                    <PanelCell label={t("Setting")}>Transport</PanelCell>
                    <PanelCell label={t("Value")} className="font-mono">
                      {server.transport}
                    </PanelCell>
                  </PanelRow>
                  <PanelRow>
                    <PanelCell label={t("Setting")}>Command</PanelCell>
                    <PanelCell label={t("Value")} className="font-mono">
                      {[server.command, ...(server.args ?? [])].join(" ") || "—"}
                    </PanelCell>
                  </PanelRow>
                  <PanelRow>
                    <PanelCell label={t("Setting")}>URL</PanelCell>
                    <PanelCell label={t("Value")} className="font-mono">
                      {server.url ?? "—"}
                    </PanelCell>
                  </PanelRow>
                </PanelTable>
                <Callout>
                  {t(
                    "No per-tool grants are recorded. In a member's run an MCP tool follows the member's permission mode (ask → approval card, auto → classifier, deny → blocked, yolo → ungated); a test call from this page is neither approved nor audited.",
                  )}
                </Callout>
                <PanelTable
                  label={t("Bound members")}
                  columns={[t("Member"), t("Permission mode"), t("Binding")]}
                >
                  {bound.map((member) => (
                    <PanelRow key={member.id}>
                      <PanelCell label={t("Member")}>
                        <Link
                          href={`/team/${member.id}`}
                          className="flex items-center gap-2 text-(--ink) hover:text-(--primary)"
                        >
                          <RoleAvatar kind={roleKindOf(member)} name={member.name} size="sm" />
                          {member.name}
                        </Link>
                      </PanelCell>
                      <PanelCell label={t("Permission mode")} className="font-mono">
                        {member.permissionMode ?? "—"}
                      </PanelCell>
                      <PanelCell label={t("Binding")}>
                        {t(bindingOf(member, server.serverId) === "bound" ? "enabled" : "disabled")}
                      </PanelCell>
                    </PanelRow>
                  ))}
                  {bound.length === 0 && (
                    <PanelRow>
                      <PanelCell label={t("Member")} className="text-(--mute)">
                        {t("No member binds this connection.")}
                      </PanelCell>
                    </PanelRow>
                  )}
                </PanelTable>
              </div>
            ) : (
              <div className="space-y-3">
                <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                  ← {t("Connection")}
                </Button>
                <ToolPanel
                  serverId={server.serverId}
                  catalog={
                    catalog.data ?? { status: "", latencyMs: null, schemaHash: null, tools: [] }
                  }
                  tool={tool}
                />
              </div>
            )}
          </section>
        </div>
        <SheetFooter className="flex-row flex-wrap justify-end bg-(--canvas-soft)">
          <Button variant="outline" size="sm" onClick={onEdit}>
            {t("Edit")}
          </Button>
          <Button variant="outline" size="sm" onClick={onTest}>
            {t("Test connection")}
          </Button>
          <Button variant="outline" size="sm" onClick={onBind}>
            {t("Bind members")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== "idle"}
            onClick={() => void run("restart")}
          >
            {t("Restart")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy !== "idle"}
            onClick={() => void run("delete")}
          >
            {t("Delete")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ── Test connection dialog ─────────────────────────────────────────────────────

function TestDialog({ server, onClose }: { server: McpCatalogRow; onClose: () => void }) {
  const test = useTestMcpConnection();
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <p className="text-[10px] tracking-kicker uppercase text-(--mute)">{t("CONNECTION")}</p>
          <DialogTitle>
            {t("Test connection")} · {server.name}
          </DialogTitle>
          <DialogDescription>
            {t(
              "Reconnects from the stored settings and reports what the connection manager saw. It does not call any tool. The answer carries no failure reason.",
            )}
          </DialogDescription>
        </DialogHeader>
        {test.isPending && <Fact name="Connection" state="Connecting" tone="warn" />}
        {test.data !== undefined && (
          <Fact
            name="Connection"
            state={
              test.data.status === "connected"
                ? t("Connected · {count} tools", { count: test.data.toolsCount })
                : test.data.status
            }
            tone={test.data.status === "connected" ? "ok" : "err"}
          />
        )}
        {test.isError && (
          <p className="text-xs text-(--err)">
            {t("The test request failed: {reason}", { reason: errorText(test.error) })}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={test.isPending}
            onClick={() => void test.mutate(server.serverId)}
          >
            {test.isPending ? t("Testing…") : t("Test again")}
          </Button>
          <Button onClick={onClose}>{t("Close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Bind members ───────────────────────────────────────────────────────────────

function BindDialog({
  server,
  members,
  onClose,
}: {
  server: McpCatalogRow;
  members: AgentRow[];
  onClose: () => void;
}) {
  const setBinding = useSetAgentMcpServers();
  const qc = useQueryClient();
  const [checked, setChecked] = useState<Readonly<Record<string, boolean>>>(() => {
    const initial: Record<string, boolean> = {};
    for (const member of members) {
      initial[member.id] = bindingOf(member, server.serverId) === "bound";
    }
    return initial;
  });
  const changes = bindChanges(members, server.serverId, checked);

  async function save(): Promise<void> {
    try {
      for (const change of changes) await setBinding.mutateAsync(change);
      void qc.invalidateQueries({ queryKey: ["mcp-catalog"] });
      onClose();
    } catch (error) {
      toast.error(t("Binding not saved"), { description: errorText(error) });
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("Bind members")} · {server.name}
          </DialogTitle>
          <DialogDescription>
            {t(
              "A bound member's runs can see this connection's tools, under the member's permission mode. Saving rewrites only the members whose box you changed.",
            )}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {members.map((member) => (
            <li key={member.id}>
              <Label className="flex cursor-pointer items-center gap-3 rounded-lg p-2  text-xs font-normal hover:bg-white/3">
                <Checkbox
                  checked={checked[member.id] === true}
                  onCheckedChange={(value) =>
                    setChecked((prev) => ({ ...prev, [member.id]: value === true }))
                  }
                />
                <RoleAvatar kind={roleKindOf(member)} name={member.name} size="sm" />
                <span className="text-(--ink)">{member.name}</span>
                <span className="ml-auto font-mono text-[10px] text-(--mute)">
                  {member.permissionMode ?? "—"}
                </span>
              </Label>
            </li>
          ))}
          {members.length === 0 && (
            <li className="px-2 text-xs text-(--mute)">{t("No members yet.")}</li>
          )}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={setBinding.isPending || changes.length === 0}
            onClick={() => void save()}
          >
            {t("Save {count} changes", { count: changes.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Form (add / edit) ──────────────────────────────────────────────────────────

type FormTab = "form" | "json";

function ServerFormSheet({
  server,
  onClose,
}: {
  /** The connection being edited, or null to add one. Only its non-secret fields are read. */
  server: McpCatalogRow | null;
  onClose: () => void;
}) {
  const create = useCreateMcpServer();
  const update = useUpdateMcpServer();
  const initial = server === null ? EMPTY_FORM : formFromServer(server);
  const [text, setText] = useState<ServerForm>(initial);
  const [tab, setTab] = useState<FormTab>("form");
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(text) !== JSON.stringify(initial);
  const busy = create.isPending || update.isPending;
  const stored = server === null ? { env: 0, headers: 0 } : mcpFacts(server, undefined).secrets;

  function set<K extends keyof ServerForm>(key: K, value: ServerForm[K]): void {
    setText((prev) => ({ ...prev, [key]: value }));
  }

  function storedLine(count: number): ReactNode {
    if (count === 0) return undefined;
    return t("{count} values stored, not shown", { count });
  }

  function secretsHint(): string {
    return t(
      "One KEY=VALUE per line. Leave empty to keep what is stored; saving replaces every stored value with these lines.",
    );
  }

  async function saveJson(): Promise<void> {
    try {
      for (const settings of serversFromJson(text.json)) await create.mutateAsync(settings);
      onClose();
    } catch (err) {
      setError(
        err instanceof SyntaxError
          ? t('Invalid JSON: expected one server or { "mcpServers": { ... } }')
          : errorText(err),
      );
    }
  }

  async function saveForm(): Promise<void> {
    const built = server === null ? createSettingsFrom(text) : updateSettingsFrom(text);
    if (text.name.trim() === "") {
      setError(t("A connection needs a name."));
      return;
    }
    if (!built.ok) {
      setError(t("Every line must be KEY=VALUE, and a stored mask (****) cannot be saved."));
      return;
    }
    try {
      if (server === null)
        await create.mutateAsync({ ...built.settings, transport: text.transport });
      else await update.mutateAsync({ serverId: server.serverId, settings: built.settings });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function save(): Promise<void> {
    setError(null);
    if (tab === "json") {
      await saveJson();
      return;
    }
    await saveForm();
  }

  return (
    <ResourceEditorSheet
      open
      kicker={server === null ? t("ADD CONNECTION") : t("EDIT CONNECTION")}
      title={server === null ? t("Add connection") : t("Edit {name}", { name: server.name })}
      description={t("Configuration only. Saving does not test whether the server is reachable.")}
      onClose={onClose}
      dirty={dirty}
      footer={(requestClose) => (
        <>
          <Button variant="outline" onClick={requestClose}>
            {t("Cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? t("Saving…") : t("Save")}
          </Button>
        </>
      )}
    >
      <div className="space-y-4 p-6">
        {server === null && (
          <div className="flex gap-1">
            <Button
              variant={tab === "form" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setTab("form")}
            >
              {t("Form")}
            </Button>
            <Button
              variant={tab === "json" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setTab("json")}
            >
              {t("Paste JSON")}
            </Button>
          </div>
        )}
        {tab === "json" ? (
          <Field
            label={t("JSON")}
            hint={t(
              'One server object, or { "mcpServers": { ... } } as client configs are written. Each entry is added as its own connection.',
            )}
          >
            <Textarea
              aria-label={t("JSON")}
              value={text.json}
              onChange={(e) => set("json", e.target.value)}
              rows={14}
              className="font-mono text-[11px]"
            />
          </Field>
        ) : (
          <div className="space-y-4">
            <Field label={t("Name *")}>
              <Input value={text.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field
              label={t("Transport")}
              hint={server === null ? undefined : t("Fixed when the connection was added.")}
            >
              {server === null ? (
                <Select
                  value={text.transport}
                  onValueChange={(value) => set("transport", value === "sse" ? "sse" : "stdio")}
                >
                  <SelectTrigger className="w-full" aria-label={t("Transport")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">{t("stdio · command")}</SelectItem>
                    <SelectItem value="sse">{t("HTTP · URL")}</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-(--body)">
                  {t(server.transport === "sse" ? "HTTP · URL" : "stdio · command")}
                </p>
              )}
            </Field>
            {text.transport === "stdio" ? (
              <>
                <Field label={t("Command")}>
                  <Input
                    value={text.command}
                    onChange={(e) => set("command", e.target.value)}
                    className="font-mono"
                  />
                </Field>
                <Field label={t("Args")} hint={t("Separated by spaces.")}>
                  <Input
                    value={text.args}
                    onChange={(e) => set("args", e.target.value)}
                    className="font-mono"
                  />
                </Field>
              </>
            ) : (
              <Field label={t("URL")}>
                <Input
                  value={text.url}
                  onChange={(e) => set("url", e.target.value)}
                  className="font-mono"
                  placeholder="https://"
                />
              </Field>
            )}
            <Field label={t("Env")} hint={server === null ? secretsHint() : secretsHint()}>
              {storedLine(stored.env)}
              <Textarea
                aria-label={t("Env")}
                value={text.env}
                onChange={(e) => set("env", e.target.value)}
                rows={4}
                placeholder={"KEY=VALUE"}
                className="font-mono text-[11px]"
              />
            </Field>
            <Field label={t("Headers")} hint={secretsHint()}>
              {storedLine(stored.headers)}
              <Textarea
                aria-label={t("Headers")}
                value={text.headers}
                onChange={(e) => set("headers", e.target.value)}
                rows={4}
                placeholder={"KEY=VALUE"}
                className="font-mono text-[11px]"
              />
            </Field>
          </div>
        )}
        {error !== null && (
          <p className="text-xs text-(--err)">
            {t("Not saved")}: {error}
          </p>
        )}
        <Note>
          {t(
            "A saved connection does not mean it is reachable. Discover tools or test the connection afterwards.",
          )}
        </Note>
      </div>
    </ResourceEditorSheet>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function McpCatalogPage() {
  const catalog = useMcpCatalog();
  const agents = useAgentList();
  const restart = useRestartMcpServer();
  const remove = useDeleteMcpServer();
  const { confirm, dialog } = useConfirm();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [testId, setTestId] = useState<string | null>(null);
  const [bindId, setBindId] = useState<string | null>(null);
  /** The connection being edited, or null while the form is closed. */
  const [editId, setEditId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState<"closed" | "add" | "edit">("closed");
  const [ask, setAsk] = useState<AskPaRequest | null>(null);
  const members = agents.data ?? [];
  const rows = catalog.data?.mcpServers;

  function serverOf(id: string | null): McpCatalogRow | undefined {
    if (id === null || rows === undefined) return undefined;
    return rows.find((row) => row.serverId === id);
  }

  function find(id: string | null): McpCatalogRow {
    const found = serverOf(id);
    if (found === undefined) throw new Error("MCP connection is not in the catalog");
    return found;
  }

  async function restartServer(server: McpCatalogRow): Promise<void> {
    const go = await confirm({
      title: t("Restart {name}?", { name: server.name }),
      description: t(
        "It disconnects and connects again from the stored settings. It does not call any tool.",
      ),
      confirmText: t("Restart"),
    });
    if (!go) return;
    try {
      const result = await restart.mutateAsync(server.serverId);
      toast.message(t("Restart answered: {status}", { status: result.status }));
    } catch (error) {
      toast.error(t("Restart failed"), { description: errorText(error) });
    }
  }

  async function deleteServer(server: McpCatalogRow): Promise<void> {
    const go = await confirm({
      title: t("Delete {name}?", { name: server.name }),
      description: t("Members that bind it lose the binding. This cannot be undone."),
      destructive: true,
      confirmText: t("Delete"),
    });
    if (!go) return;
    try {
      await remove.mutateAsync(server.serverId);
      setDetailId(null);
    } catch (error) {
      toast.error(t("Delete failed"), { description: errorText(error) });
    }
  }

  const askRequest: AskPaRequest = {
    title: t("MCP connections"),
    description: t("Advice only: the PA has no tool that edits a connection."),
    draft: t(
      "Which MCP connections do the team's members actually use, and are any of them unreachable or unused?",
    ),
  };

  return (
    <Page>
      <PageHeader
        kicker="MCP CONNECTIONS · CATALOG"
        title="MCP connections"
        subtitle="See connection settings and tool catalogs. The catalog, connectivity and execution authorization are stated separately."
        actions={
          <>
            <Button variant="violet" onClick={() => setAsk(askRequest)}>
              {t("Ask the PA")}
            </Button>
            <Button
              onClick={() => {
                setEditId(null);
                setFormOpen("add");
              }}
            >
              <Plus className="size-4" /> {t("Add connection")}
            </Button>
          </>
        }
      />
      <PageBody>
        <Callout>
          <Plug className="size-3.5 shrink-0" />
          {t(
            "A saved connection does not mean it is reachable. The tool catalog appears only after discovery; a connection test does not call any tool.",
          )}
        </Callout>
        <QueryState
          query={catalog}
          empty={(data) => data.mcpServers.length === 0}
          emptyTitle={t("No connections yet")}
          emptyDescription={t(
            "Add a connection to reach an MCP server's tools from a member's runs.",
          )}
          emptyIcon={Plug}
        >
          {(data) => (
            <div className="grid gap-4 md:grid-cols-2">
              {data.mcpServers.map((server) => (
                <ServerCard
                  key={server.serverId}
                  server={server}
                  members={members}
                  onDetail={() => setDetailId(server.serverId)}
                  onEdit={() => {
                    setEditId(server.serverId);
                    setFormOpen("edit");
                  }}
                  onTest={() => setTestId(server.serverId)}
                  onBind={() => setBindId(server.serverId)}
                  onRestart={() => void restartServer(server)}
                  onDelete={() => void deleteServer(server)}
                />
              ))}
            </div>
          )}
        </QueryState>
        {members.length === 0 && catalog.data !== undefined && (
          <Note className="mt-4">{t("No members yet, so nothing binds a connection.")}</Note>
        )}
      </PageBody>

      {detailId !== null && rows !== undefined && serverOf(detailId) !== undefined && (
        <ServerSheet
          server={find(detailId)}
          members={members}
          onClose={() => setDetailId(null)}
          onEdit={() => {
            setEditId(detailId);
            setFormOpen("edit");
            setDetailId(null);
          }}
          onTest={() => setTestId(detailId)}
          onBind={() => setBindId(detailId)}
          onRestart={() => restartServer(find(detailId))}
          onDelete={() => deleteServer(find(detailId))}
        />
      )}
      {testId !== null && serverOf(testId) !== undefined && (
        <TestDialog server={find(testId)} onClose={() => setTestId(null)} />
      )}
      {bindId !== null && serverOf(bindId) !== undefined && (
        <BindDialog server={find(bindId)} members={members} onClose={() => setBindId(null)} />
      )}
      {formOpen !== "closed" && (
        <ServerFormSheet server={serverOf(editId) ?? null} onClose={() => setFormOpen("closed")} />
      )}
      {dialog}
      <AskPaSheet request={ask} onClose={() => setAsk(null)} />
    </Page>
  );
}
