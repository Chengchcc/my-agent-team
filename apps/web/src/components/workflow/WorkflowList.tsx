"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Page, PageBody, PageHeader } from "@/components/page";
import { KpiTile, StatusPill } from "@/components/patterns";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ExecutionRowsList, type WorkflowExec } from "@/components/workflow/ExecutionRowsList";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

type Row = {
  workflowId: string;
  name?: string;
  description?: string;
  tags?: string[];
  status?: string;
  owner?: string;
  updatedBy?: string;
  updatedAt?: number;
  lastExecution?: {
    executionId: string;
    status: string;
    createdAt: number;
    terminalAt?: number;
    error?: string;
  };
  /** Cron trigger declarations (cron type only; API/manual are implicit). */
  triggers?: Array<{ type: "cron"; cron: string; enabled?: boolean }>;
  /** The server will refuse to run this definition: it has a script node and
   *  scripts are disabled here. */
  scriptNodesBlocked?: boolean;
};

function defaultDraft(id: string) {
  return {
    version: 1,
    id,
    meta: { name: id, status: "draft" },
    nodes: [
      { id: "start", type: "start" },
      { id: "done", type: "end", status: "success" },
    ],
    edges: [{ from: "start", to: "done" }],
  };
}

/** Kebab-case id from a display name. The workflow id is written to
 *  workflows/<id>.workflow.json and appears in the editor title, the chat
 *  <workflow-context> the agent reads, and the run URLs — so it must be a
 *  readable slug, not a random token. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** A workflow parameter's type word, from either shape the definition uses:
 *  a bare word, or a schema object whose `type` may be a list. */
function paramHintOf(schema: unknown): "string" | "number" | "boolean" {
  if (typeof schema === "string") {
    return schema === "number" || schema === "integer"
      ? "number"
      : schema === "boolean"
        ? "boolean"
        : "string";
  }
  if (schema !== null && typeof schema === "object" && "type" in schema) {
    const types = schema.type;
    const first = Array.isArray(types) ? types[0] : types;
    return first === "number" || first === "integer"
      ? "number"
      : first === "boolean"
        ? "boolean"
        : "string";
  }
  return "string";
}

export function WorkflowList({ definitions }: { definitions: Row[] }) {
  const router = useRouter();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [runDef, setRunDef] = useState<{
    /** The definition's parameters: an array of `{ key, type }` descriptors
     *  (packages/workflow InputHint), or none. Rendering a descriptor as text
     *  crashed the page on every Run of a workflow with parameters (live
     *  2026-11-24). */
    input?: Array<{ key: string; type: string | string[] }> | null;
  } | null>(null);
  const [runBlocked, setRunBlocked] = useState(false);
  const [runVals, setRunVals] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [newName, setNewName] = useState("");
  const [sheetWorkflowId, setSheetWorkflowId] = useState<string | null>(null);
  const [sheetExecs, setSheetExecs] = useState<WorkflowExec[]>([]);
  const [sheetLoading, setSheetLoading] = useState(false);

  async function openExecutions(workflowId: string) {
    setSheetWorkflowId(workflowId);
    setSheetExecs([]);
    setSheetLoading(true);
    api
      .listWorkflowExecutions(workflowId)
      .then((r) => setSheetExecs((r?.executions ?? []) as WorkflowExec[]))
      .catch(() => setSheetExecs([]))
      .finally(() => setSheetLoading(false));
  }

  const cronCount = definitions.filter((d) => (d.triggers ?? []).length > 0).length;
  const dayAgo = Date.now() - 86_400_000;
  const recentRuns = definitions.filter((d) => (d.lastExecution?.createdAt ?? 0) > dayAgo).length;
  const recentFailures = definitions.filter(
    (d) =>
      d.lastExecution &&
      d.lastExecution.status === "failure" &&
      (d.lastExecution.createdAt ?? 0) > dayAgo,
  ).length;

  async function create(templateId?: string) {
    const name = newName.trim();
    const id = slugify(name);
    if (!id) {
      toast.error("Give the workflow a name first.");
      return;
    }
    if (definitions.some((d) => d.workflowId === id)) {
      toast.error(`A workflow named "${name}" already exists.`);
      return;
    }
    let def: Record<string, unknown> = defaultDraft(id) as Record<string, unknown>;
    def = { ...def, id, meta: { ...(def.meta as Record<string, unknown>), name } };
    if (templateId) {
      try {
        const t = await api.getWorkflowDefinition(templateId);
        if (t?.definition) {
          def = {
            ...(t.definition as Record<string, unknown>),
            id,
            triggers: [],
            meta: {
              ...((t.definition as { meta?: Record<string, unknown> }).meta ?? {}),
              name,
              status: "draft",
            },
          };
        }
      } catch {
        /* template missing — fall back to blank draft */
      }
    }
    try {
      await api.saveWorkflowDefinition(id, def);
      toast.success(`Created "${name}"`);
      router.push(`/workflows/${id}`);
    } catch (err) {
      toast.error(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  async function openRun(id: string) {
    setRunId(id);
    setRunVals({});
    // The server says whether this definition needs a script node it may not
    // run. Saying so here beats a 403 after the click (audit 2026-11-24).
    setRunBlocked(definitions.find((d) => d.workflowId === id)?.scriptNodesBlocked === true);
    try {
      const def = await api.getWorkflowDefinition(id);
      setRunDef(def?.definition ?? null);
    } catch {
      setRunDef(null);
    }
  }
  async function run() {
    if (!runId || running) return;
    setRunning(true);
    const input: Record<string, unknown> = {};
    for (const param of runDef?.input ?? []) {
      const hint = paramHintOf(param.type);
      const raw = runVals[param.key] ?? "";
      if (!raw) continue;
      input[param.key] =
        hint === "number" ? Number(raw) : hint === "boolean" ? raw === "true" : raw;
    }
    try {
      await api.startWorkflowExecution({
        workflowRef: { path: `${runId}.workflow.json` },
        input,
      });
      router.push(`/workflows/${runId}/executions`);
    } catch (err) {
      toast.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }
  async function del(id: string) {
    await api.deleteWorkflowDefinition(id);
    window.location.reload();
  }
  return (
    <Page>
      <PageHeader
        breadcrumb="Work / Workflows"
        title="Workflows"
        pill={
          cronCount > 0 ? <StatusPill tone="idle">{cronCount} scheduled</StatusPill> : undefined
        }
        actions={
          <Button size="sm" onClick={() => setNewOpen(true)}>
            + New
          </Button>
        }
      />
      <PageBody size="wide" className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <KpiTile label={t("Definitions")} value={definitions.length} detail={t("workflows")} />
          <KpiTile
            label={t("Scheduled")}
            value={cronCount}
            detail="cron triggers"
            bar={definitions.length === 0 ? 0 : (cronCount / definitions.length) * 100}
            barTone="violet"
          />
          <KpiTile
            label={t("Last 24h runs")}
            value={recentRuns}
            detail={recentFailures > 0 ? `${recentFailures} failed` : "all clear"}
            bar={recentRuns === 0 ? 0 : ((recentRuns - recentFailures) / recentRuns) * 100}
            barTone="ok"
          />
        </div>
        {definitions.map((d) => (
          <div
            key={d.workflowId}
            className="flex items-center justify-between rounded-xl border border-(--hairline) bg-(--panel)/70 p-3"
          >
            <div>
              <Link href={`/workflows/${d.workflowId}`} className="font-medium hover:underline">
                {d.name ?? d.workflowId}
              </Link>
              {d.description && (
                <div className="text-xs text-muted-foreground">{d.description}</div>
              )}
              <div className="mt-1 flex flex-wrap gap-1">
                {d.triggers?.some((t) => t.enabled !== false) && (
                  <span className="rounded-md bg-(--primary)/10 px-1.5 py-0.5 text-[10px] text-(--primary)">
                    ⏰ schedule · {d.triggers.find((t) => t.enabled !== false)!.cron}
                  </span>
                )}
                {d.tags?.map((t) => (
                  <span
                    key={t}
                    className="rounded-md bg-(--panel2) px-1.5 py-0.5 font-mono text-[10px] text-(--info)"
                  >
                    {t}
                  </span>
                ))}
                {d.status && (
                  <span className="rounded-full border border-(--primary)/40 bg-(--primary)/10 px-2 py-0.5 text-[10px] text-(--primary)">
                    {d.status}
                  </span>
                )}
              </div>
              {d.lastExecution && (
                <div className="mt-1 flex items-center gap-2 text-[10px] text-(--mute)">
                  <button
                    type="button"
                    onClick={() =>
                      d.lastExecution?.executionId &&
                      router.push(
                        `/workflows/${d.workflowId}/executions/${d.lastExecution.executionId}`,
                      )
                    }
                    className={`rounded-full px-1.5 py-0.5 transition-colors hover:ring-1 hover:ring-(--primary)/40 ${
                      d.lastExecution.status === "success"
                        ? "bg-(--primary)/10 text-(--primary)"
                        : d.lastExecution.status === "failure"
                          ? "bg-(--err)/10 text-(--err)"
                          : "bg-(--panel2) text-(--mute)"
                    }`}
                    title={t("Open this execution")}
                  >
                    {d.lastExecution.status === "waiting_human"
                      ? "Awaiting confirmation"
                      : d.lastExecution.status}
                  </button>
                  <span>{new Date(d.lastExecution.createdAt).toLocaleString("en-US")}</span>
                  {d.lastExecution.terminalAt && d.lastExecution.createdAt && (
                    <span>
                      {Math.max(
                        0,
                        Math.round((d.lastExecution.terminalAt - d.lastExecution.createdAt) / 1000),
                      )}
                      s
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex shrink-0 gap-2 text-xs">
              <Button variant="outline" size="sm" onClick={() => openRun(d.workflowId)}>
                Run
              </Button>
              <Button variant="outline" size="sm" onClick={() => openExecutions(d.workflowId)}>
                Executions
              </Button>
              <Button variant="destructive" size="sm" onClick={() => setConfirmId(d.workflowId)}>
                Delete
              </Button>
            </div>
          </div>
        ))}
        {definitions.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No workflows yet — press <b>+ New</b> above to start from a template.
          </div>
        )}
      </PageBody>
      <Dialog
        open={newOpen}
        onOpenChange={(o) => {
          setNewOpen(o);
          if (!o) setNewName("");
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">{t("New Workflow")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="new-wf-name" className="text-xs text-(--mute)">
                Name
              </Label>
              <Input
                id="new-wf-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault();
                }}
                placeholder="e.g. Release verification flow"
                autoFocus
                className="h-9"
              />
              {!slugify(newName) && newName.trim().length > 0 && (
                <p className="text-[10px] text-(--err)">
                  Name needs at least one letter or number.
                </p>
              )}
              {slugify(newName) && (
                <p className="font-mono text-[10px] text-(--faint)">id: {slugify(newName)}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-(--mute)">{t("Start from")}</Label>
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex h-auto w-full flex-col items-start gap-0.5 px-3 py-2 text-left"
                  onClick={() => void create()}
                >
                  <span className="font-medium">{t("Blank canvas")}</span>
                  <span className="line-clamp-1 text-[10px] font-normal text-(--mute)">
                    start → end, build from scratch
                  </span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex h-auto w-full flex-col items-start gap-0.5 px-3 py-2 text-left"
                  onClick={() => void create("nighttime-report")}
                >
                  <span className="font-medium">Nightly code quality report</span>
                  <span className="line-clamp-1 text-[10px] font-normal text-(--mute)">
                    Agent scans repo → report → human confirmation
                  </span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex h-auto w-full flex-col items-start gap-0.5 px-3 py-2 text-left"
                  onClick={() => void create("self-heal")}
                >
                  <span className="font-medium">Issue self-heal</span>
                  <span className="line-clamp-1 text-[10px] font-normal text-(--mute)">
                    Detect → auto-fix → human confirm → fork exit
                  </span>
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={runId !== null}
        onOpenChange={(o) => {
          if (!o) setRunId(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">Run {runId}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {(runDef?.input ?? []).length === 0 ? (
              <p className="text-xs text-(--mute)">{t("This workflow has no input parameters.")}</p>
            ) : (
              (runDef?.input ?? []).map((param) => {
                const key = param.key;
                const hint = paramHintOf(param.type);
                return (
                  <div key={key} className="flex flex-col gap-1">
                    <Label className="text-xs text-(--mute)">
                      {key} <span className="text-(--faint)">({hint})</span>
                    </Label>
                    <Input
                      className="h-9 border-(--hairline) bg-(--canvas) text-xs"
                      type={hint === "number" ? "number" : hint === "boolean" ? "text" : "text"}
                      placeholder={hint === "boolean" ? "true / false" : ""}
                      value={runVals[key] ?? ""}
                      onChange={(e) => setRunVals((v) => ({ ...v, [key]: e.target.value }))}
                    />
                  </div>
                );
              })
            )}
            {runBlocked && (
              <p className="rounded-md border border-(--warn)/40 bg-(--warn)/10 px-2 py-1.5 text-xs text-(--warn)">
                {t(
                  "This workflow runs a script node, and scripts are disabled on this server. It can be edited here, not run.",
                )}
              </p>
            )}
            <Button className="w-full" onClick={run} disabled={running || runBlocked}>
              {running ? t("Starting…") : t("Run")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={confirmId !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete workflow {confirmId}?</AlertDialogTitle>
            <AlertDialogDescription>{t("This cannot be undone.")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmId) void del(confirmId);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Sheet open={sheetWorkflowId !== null} onOpenChange={(o) => !o && setSheetWorkflowId(null)}>
        <SheetContent className="w-[92vw] max-w-[760px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="truncate">{t("Executions")}</SheetTitle>
            <SheetDescription className="truncate">Runs of {sheetWorkflowId}</SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-2">
            {sheetLoading ? (
              <div className="text-sm text-(--mute)">Loading…</div>
            ) : (
              sheetWorkflowId && (
                <ExecutionRowsList
                  workflowId={sheetWorkflowId}
                  executions={sheetExecs}
                  onMutated={() => openExecutions(sheetWorkflowId)}
                />
              )
            )}
          </div>
        </SheetContent>
      </Sheet>
    </Page>
  );
}
