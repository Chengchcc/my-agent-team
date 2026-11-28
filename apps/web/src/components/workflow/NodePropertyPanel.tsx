"use client";

import type { InputHint, WorkflowDefinition, WorkflowNode } from "@chengchenccc/workflow";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import "@/lib/monaco-loader";
import { HumanFormEditor } from "./HumanFormEditor";
import { InputPanel } from "./InputPanel";
import { OutputFieldsEditor } from "./OutputFieldsEditor";

const MonacoCodeEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => <div className="p-2 text-xs text-(--mute)">{t("Loading editor…")}</div>,
});

type Def = WorkflowDefinition;

function patchNode(def: Def, nodeId: string, patch: Record<string, unknown>): Def {
  return {
    ...def,
    nodes: def.nodes.map((n) => (n.id === nodeId ? ({ ...n, ...patch } as WorkflowNode) : n)),
  };
}

function renameNode(def: Def, oldId: string, newId: string): Def {
  if (!oldId || !newId || oldId === newId) return def;
  return {
    ...def,
    nodes: def.nodes.map((n) => (n.id === oldId ? ({ ...n, id: newId } as WorkflowNode) : n)),
    edges: def.edges.map((e) => ({
      ...e,
      from: e.from === oldId ? newId : e.from,
      to: e.to === oldId ? newId : e.to,
    })),
  };
}

const TYPE_LABEL: Record<string, string> = {
  start: "Start",
  end: "End",
  agent: "Agent",
  script: "Script",
  human: "Human",
};

/** Node inspector — edits write straight back to the DSL (live). */
export function NodePropertyPanel({
  workflowId,
  nodeId,
  definition,
  onChange,
}: {
  workflowId: string;
  nodeId: string;
  definition: Def;
  onChange: (def: Def) => void;
}) {
  const node = useMemo(() => definition.nodes.find((n) => n.id === nodeId), [definition, nodeId]);
  const [agents, setAgents] = useState<Array<{ id: string; name?: string }>>([]);
  const [debugOpen, setDebugOpen] = useState<"open" | "closed">("closed");
  const [debugInput, setDebugInput] = useState("");
  const [debugResult, setDebugResult] = useState<string | null>(null);
  const [debugBusy, setDebugBusy] = useState<"busy" | "idle">("idle");
  useEffect(() => {
    api
      .listAgents()
      .then((rows) =>
        setAgents((rows ?? []).map((a) => ({ id: a.id, name: (a as { name?: string }).name }))),
      )
      .catch(() => setAgents([]));
  }, []);
  if (!node) return null;

  const set = (patch: Record<string, unknown>) => onChange(patchNode(definition, nodeId, patch));

  return (
    <div className="flex h-full flex-col overflow-auto p-4 text-(--ink)">
      <div className="mb-3 flex items-center justify-between">
        <Input
          className="min-w-0 flex-1 border-(--hairline) bg-(--canvas) font-mono text-xs text-(--info)"
          value={nodeId}
          placeholder={t("Node id")}
          onChange={(e) => onChange(renameNode(definition, nodeId, e.target.value))}
        />
        <Badge variant="outline" className="shrink-0 border-(--hairline) text-[10px] text-(--mute)">
          {t(TYPE_LABEL[node.type] ?? node.type)}
        </Badge>
        <button
          type="button"
          className="shrink-0 rounded-md border border-(--info)/40 bg-(--info)/10 px-2 py-1 text-[10px] text-(--info) hover:bg-(--info)/20"
          onClick={() => setDebugOpen("open")}
        >
          {node.type === "script" ? t("Test script") : t("Debug")}
        </button>
      </div>
      <div className="mb-4 space-y-1">
        <Label className="text-xs text-(--mute)">
          {t("name")} <span className="ml-1.5 font-mono text-[10px] text-(--faint)">name</span>
        </Label>
        <Input
          className="border-(--hairline) bg-(--canvas) text-xs"
          value={(node as { label?: string }).label ?? ""}
          placeholder={t("Node label (shown on canvas)")}
          onChange={(e) => set({ label: e.target.value })}
        />
      </div>

      {node.type === "start" && (
        <div className="space-y-3">
          <InputPanel definition={definition} onChange={onChange} />
        </div>
      )}

      {node.type === "agent" && (
        <>
          <div className="space-y-1">
            <Label className="text-xs text-(--mute)">{t("Agent (select from system)")}</Label>
            <Select value={node.agentId ?? ""} onValueChange={(v) => set({ agentId: v })}>
              <SelectTrigger className="h-8 w-full border-(--hairline) bg-(--canvas) font-mono text-xs">
                <SelectValue
                  placeholder={t("Select agent, or leave blank to inline model+prompt")}
                />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name ? `${a.name} (${a.id})` : a.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="mt-3 space-y-1">
            <Label className="text-xs text-(--mute)">
              {t("Capability (dynamic teammate routing)")}{" "}
              <span className="ml-1.5 font-mono text-[10px] text-(--faint)">capability</span>
            </Label>
            <Input
              className="border-(--hairline) bg-(--canvas) font-mono text-xs"
              value={node.capability ?? ""}
              placeholder={t("e.g. code-review, frontend, devops (used when Agent is blank)")}
              onChange={(e) => set({ capability: e.target.value || undefined })}
            />
          </div>
          <div className="mt-3 space-y-1">
            <Label className="text-xs text-(--mute)">
              {t("model")}{" "}
              <span className="ml-1.5 font-mono text-[10px] text-(--faint)">model</span>
            </Label>
            <Input
              className="border-(--hairline) bg-(--canvas) font-mono text-xs"
              value={node.model ?? ""}
              placeholder="deepseek/deepseek-v4-flash"
              onChange={(e) => set({ model: e.target.value })}
            />
          </div>
          <div className="mt-3 space-y-1">
            <Label className="text-xs text-(--mute)">
              {t("prompt")}{" "}
              <span className="ml-1.5 font-mono text-[10px] text-(--faint)">prompt</span>
            </Label>
            <Textarea
              className="min-h-24 border-(--hairline) bg-(--canvas) font-mono text-xs"
              value={node.prompt ?? ""}
              onChange={(e) => set({ prompt: e.target.value })}
            />
          </div>
          <div className="mt-3 space-y-1">
            <Label className="text-xs text-(--mute)">
              {t("Output fields (usable in edge conditions)")}
            </Label>
            <OutputFieldsEditor
              output={(node as { output?: InputHint }).output}
              onChange={(o) => set({ output: o })}
            />
          </div>
        </>
      )}

      {node.type === "script" && (
        <>
          <div className="space-y-1">
            <Label className="text-xs text-(--mute)">
              {t("code")} <span className="ml-1.5 font-mono text-[10px] text-(--faint)">code</span>
            </Label>
            <div className="overflow-hidden rounded-md border border-(--hairline)">
              <MonacoCodeEditor
                height="300px"
                defaultLanguage="javascript"
                value={node.code ?? ""}
                onChange={(v) => set({ code: v ?? "" })}
                theme="workflow-dark"
                beforeMount={(monaco) => {
                  monaco.editor.defineTheme("workflow-dark", {
                    base: "vs-dark",
                    inherit: true,
                    rules: [],
                    colors: {
                      "editor.background": "var(--canvas)",
                      "editor.foreground": "var(--ink)",
                      "editor.lineHighlightBackground": "var(--panel2)",
                      "editorIndentGuide.background": "var(--hairline)",
                      "editorGutter.background": "var(--canvas)",
                      "editorCursor.foreground": "var(--primary)",
                      "editor.selectionBackground": "var(--panel2)",
                    },
                  });
                }}
                options={{ minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false }}
              />
            </div>
          </div>
          <div className="mt-3 space-y-1">
            <Label className="text-xs text-(--mute)">
              {t("timeoutMs")}{" "}
              <span className="ml-1.5 font-mono text-[10px] text-(--faint)">timeoutMs</span>
            </Label>
            <Input
              type="number"
              className="border-(--hairline) bg-(--canvas) font-mono text-xs"
              value={node.timeoutMs ?? ""}
              onChange={(e) =>
                set({ timeoutMs: e.target.value === "" ? undefined : Number(e.target.value) })
              }
            />
          </div>
        </>
      )}

      {node.type === "human" && (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-(--mute)">
              {t("question")}{" "}
              <span className="ml-1.5 font-mono text-[10px] text-(--faint)">question</span>
            </Label>
            <Textarea
              className="min-h-24 border-(--hairline) bg-(--canvas) font-mono text-xs"
              value={node.question ?? ""}
              onChange={(e) => set({ question: e.target.value })}
            />
          </div>
          <HumanFormEditor
            form={(node as { form?: Record<string, unknown> }).form}
            onChange={(form) => set({ form })}
          />
        </div>
      )}

      {node.type === "end" && (
        <div className="space-y-1">
          <Label className="text-xs text-(--mute)">
            {t("status")}{" "}
            <span className="ml-1.5 font-mono text-[10px] text-(--faint)">status</span>
          </Label>
          <Input
            className="border-(--hairline) bg-(--canvas) font-mono text-xs"
            value={node.status ?? ""}
            onChange={(e) => set({ status: e.target.value })}
          />
        </div>
      )}

      {node.retry !== undefined && (
        <div className="mt-3 space-y-1">
          <Label className="text-xs text-(--mute)">
            {t("retry")} <span className="ml-1.5 font-mono text-[10px] text-(--faint)">retry</span>
          </Label>
          <Input
            type="number"
            className="border-(--hairline) bg-(--canvas) font-mono text-xs"
            value={typeof node.retry === "number" ? node.retry : ""}
            onChange={(e) => set({ retry: Number(e.target.value) })}
          />
        </div>
      )}
      <Dialog
        open={debugOpen === "open"}
        onOpenChange={(next) => setDebugOpen(next ? "open" : "closed")}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              {node.type === "script"
                ? t("Test script node {nodeId}", { nodeId })
                : t("Debug node {nodeId}", { nodeId })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label className="text-xs text-(--mute)">
              {t("input (JSON, as input for this node)")}
            </Label>
            <Textarea
              className="min-h-24 border-(--hairline) bg-(--canvas) font-mono text-xs"
              value={debugInput}
              onChange={(e) => setDebugInput(e.target.value)}
              placeholder='{"issueUrl":"..."}'
            />
            <Button
              className="w-full"
              disabled={debugBusy === "busy"}
              onClick={async () => {
                setDebugBusy("busy");
                setDebugResult(null);
                try {
                  const input = debugInput.trim() ? JSON.parse(debugInput) : {};
                  if (node.type === "script") {
                    const res = await api.testWorkflowScript({
                      code: node.code ?? "",
                      input,
                      timeoutMs: node.timeoutMs,
                    });
                    const parts = [
                      `status=${res.ok ? "ok" : "failed"} exitCode=${res.exitCode} duration=${res.durationMs}ms`,
                    ];
                    if (res.output !== undefined) {
                      parts.push(`output:\n${JSON.stringify(res.output, null, 2)}`);
                    }
                    if (res.stdout) parts.push(`stdout:\n${res.stdout}`);
                    if (res.stderr) parts.push(`stderr:\n${res.stderr}`);
                    setDebugResult(parts.join("\n\n"));
                  } else {
                    const res = await api.dryRunWorkflow(workflowId, {
                      input,
                      startNodeId: nodeId,
                    });
                    const steps = (res?.steps ?? [])
                      .map(
                        (st: { nodeId: string; output: unknown }) =>
                          `${st.nodeId}: ${JSON.stringify(st.output)}`,
                      )
                      .join("\n");
                    setDebugResult(`exit=${res?.exit}\n${steps}`);
                  }
                } catch (err) {
                  setDebugResult(
                    t("Error: {message}", {
                      message: err instanceof Error ? err.message : String(err),
                    }),
                  );
                } finally {
                  setDebugBusy("idle");
                }
              }}
            >
              {debugBusy === "busy"
                ? t("Running…")
                : node.type === "script"
                  ? t("Run in sandbox")
                  : t("Run this node")}
            </Button>
            {debugResult && (
              <pre className="max-h-48 overflow-auto rounded bg-(--canvas)/60 p-2 text-[10px] text-(--mute)">
                {debugResult}
              </pre>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
