"use client";

import type { AskQuestionInput } from "@chengchenccc/message";
import {
  parseWorkflow,
  toEditorGraph,
  type WorkflowDefinition,
  type WorkflowNode,
  WorkflowParseError,
} from "@chengchenccc/workflow";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, History, Redo2, RotateCcw, Undo2, Wand2 } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type ComponentType,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { type ComposerDraft, PaSession } from "@/components/PaSession";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { describeProposal } from "@/features/proposals/describe";
import { proposalKeys } from "@/features/proposals/queries";
import { workflowRequest } from "@/features/workflow/draft";
import {
  clearWorkflowDraft,
  readWorkflowDraft,
  writeWorkflowDraft,
} from "@/features/workflow/draft-storage";
import {
  choosePane,
  type EditorPane,
  type OpenSides,
  type SidePanel,
  toggleSide,
  visiblePanes,
} from "@/features/workflow/editor-layout";
import { useEditorWidth } from "@/features/workflow/hooks";
import {
  definitionOf,
  type ProposalNotice,
  proposalNotice,
  proposalStep,
  type Settlement,
  sameDefinition,
  settlementOf,
} from "@/features/workflow/proposal-draft";
import { workflowProposalQuery } from "@/features/workflow/queries";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { DagStatsBar } from "./DagStatsBar";
import { EdgePropertyPanel } from "./EdgePropertyPanel";
import { NodeMenuPopover } from "./NodeMenuPopover";
import { NodePanel } from "./NodePanel";
import { NodePropertyPanel } from "./NodePropertyPanel";
import { TriggerPanel } from "./TriggerPanel";
import { WorkflowCanvas } from "./WorkflowCanvas";

interface DslEditorProps {
  definition: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
  onPendingChange: (pending: boolean) => void;
}

// Monaco cannot be rendered on the server; the panel is loaded in the browser only.
const DslEditorPanel = dynamic(() => import("./DslEditorPanel").then((m) => m.DslEditorPanel), {
  ssr: false,
  loading: () => <div className="p-4 text-xs text-(--mute)">{t("Loading editor…")}</div>,
}) as ComponentType<DslEditorProps>;

type InspectorTab = "attrs" | "palette" | "triggers";
const INSPECTOR_TABS: ReadonlyArray<readonly [InspectorTab, string]> = [
  ["attrs", "Properties"],
  ["palette", "Nodes"],
  ["triggers", "Triggers"],
];

/** What the canvas can do for the zoom toolbar. */
interface CanvasZoom {
  zoomIn: () => void;
  zoomOut: () => void;
  fitView: (opts?: { padding?: number }) => void;
  setZoom: (z: number) => void;
  getZoom: () => number;
}

/** The PA's conversation about one workflow is `workflow:chat:<id>`: the same id on every visit,
 *  so it continues. */

function formToQuestions(
  form: Record<string, unknown> | undefined,
  question: string | undefined,
): AskQuestionInput {
  const questions: AskQuestionInput["questions"] = [];
  for (const [key, raw] of Object.entries(form ?? {})) {
    const f = raw as { type?: string; label?: string; options?: string[]; required?: boolean };
    const label = f.label ?? key;
    if (f.type === "enum") {
      questions.push({
        id: key,
        kind: "select",
        question: label,
        header: question,
        options: (f.options ?? []).map((v) => ({ value: v, label: v })),
        validation: { required: f.required !== false },
      });
    } else if (f.type === "boolean") {
      questions.push({
        id: key,
        kind: "select",
        question: label,
        header: question,
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
        validation: { required: f.required !== false },
      });
    } else {
      questions.push({
        id: key,
        kind: "text",
        question: label,
        header: question,
        multiline: f.type === "textarea",
        placeholder: f.label,
        validation: { required: f.required !== false },
      });
    }
  }
  if (questions.length === 0 && question) {
    questions.push({ id: "answer", kind: "text", question, multiline: true });
  }
  return { questions };
}

function makeNodeId(base: string): string {
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base}-${suffix}`;
}

function addNode(def: WorkflowDefinition, node: WorkflowNode) {
  const next = { ...def, nodes: [...def.nodes, node] };
  return next;
}

function addEdge(def: WorkflowDefinition, from: string, to: string) {
  const exists = def.edges.some((e) => e.from === from && e.to === to);
  if (exists) {
    return def;
  }
  return { ...def, edges: [...def.edges, { from, to }] };
}

function deleteNode(def: WorkflowDefinition, id: string) {
  const next = {
    ...def,
    nodes: def.nodes.filter((n) => n.id !== id),
    edges: def.edges.filter((e) => e.from !== id && e.to !== id),
  };
  return next;
}

/** One segment of a segmented control: the one place a native button is the right element. */
function Segment({
  label,
  pressed,
  onClick,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "rounded-[4px] px-2.5 py-[5px] font-mono text-[10px] whitespace-nowrap transition-colors",
        pressed ? "bg-white/[0.043] text-(--ink)" : "text-(--faint) hover:text-(--ink)",
      )}
    >
      {label}
    </button>
  );
}

/** The workflow editor. The canvas is the main area; the node inspector and the PA conversation
 *  are side panels beside it, and a panel that is not shown is not mounted. Saving is the only
 *  write: a PA proposal arrives as an unsaved draft, a schedule is switched on inside the
 *  definition and saved with it, and a run is started elsewhere. */
export function AgenticWorkflowEditor({
  workflowId,
  initial,
}: {
  workflowId: string;
  initial: WorkflowDefinition | null;
}) {
  const router = useRouter();
  const width = useEditorWidth();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [saved, setSaved] = useState<WorkflowDefinition | null>(initial);
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(initial);
  const [past, setPast] = useState<WorkflowDefinition[]>([]);
  const [future, setFuture] = useState<WorkflowDefinition[]>([]);
  const [mode, setMode] = useState<"canvas" | "dsl">("canvas");
  const [dslPending, setDslPending] = useState<"clean" | "edited">("clean");
  // As in the prototype: the node inspector starts closed, the PA session open.
  const [sides, setSides] = useState<OpenSides>({ node: false, pa: true });
  const [pane, setPane] = useState<EditorPane>("canvas");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("attrs");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeEdgeIndex, setActiveEdgeIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState<"idle" | "busy">("idle");
  const [validation, setValidation] = useState<{
    ok: boolean;
    errors?: string[];
    notes?: string[];
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyItems, setHistoryItems] = useState<
    Array<{ commit: string; author: string; timestamp: number; summary: string }>
  >([]);
  const [revertingCommit, setRevertingCommit] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ sourceId: string; x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState<CanvasZoom | null>(null);
  const [draft, setDraft] = useState<ComposerDraft | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [settled, setSettled] = useState<{ id: string; decision: Settlement } | null>(null);
  const [restoredDraftAt, setRestoredDraftAt] = useState<number | null>(null);
  const draftHydratedRef = useRef(false);
  const qc = useQueryClient();
  const definitionRef = useRef<WorkflowDefinition | null>(initial);
  definitionRef.current = definition;

  const dirty = useMemo(() => {
    if (saved === null) {
      return false;
    }
    if (definition === null) {
      return false;
    }
    return !sameDefinition(definition, saved);
  }, [definition, saved]);

  // Central setter that records history for undo/redo.
  const setDefinitionTracked = useCallback(
    (
      next: WorkflowDefinition | ((prev: WorkflowDefinition | null) => WorkflowDefinition | null),
    ) => {
      const prev = definitionRef.current;
      const resolved = typeof next === "function" ? next(prev) : next;
      if (!prev || !resolved || prev === resolved) {
        setDefinition(resolved);
        return;
      }
      setPast((p) => [...p.slice(-49), prev]);
      setFuture([]);
      setDefinition(resolved);
      definitionRef.current = resolved;
    },
    [],
  );

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prevState = p[p.length - 1]!;
      const cur = definitionRef.current;
      setFuture((f) => (cur ? [...f, cur] : f));
      setDefinition(prevState);
      definitionRef.current = prevState;
      return p.slice(0, -1);
    });
  }, []);
  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const nextState = f[f.length - 1]!;
      const cur = definitionRef.current;
      setPast((p) => (cur ? [...p, cur] : p));
      setDefinition(nextState);
      definitionRef.current = nextState;
      return f.slice(0, -1);
    });
  }, []);

  async function save(): Promise<void> {
    if (definition === null) {
      return;
    }
    if (saving === "busy") {
      return;
    }
    setSaving("busy");
    let written: WorkflowDefinition | null = null;
    try {
      await api.saveWorkflowDefinition(workflowId, { ...definition });
      written = definition;
      setSaved(definition);
      clearWorkflowDraft(workflowId);
      setRestoredDraftAt(null);
      setValidation({ ok: true });
      toast.success(t("Workflow saved"));
    } catch (err) {
      toast.error(t("Save failed"), {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving("idle");
    }
    // The proposal's row is settled only now that the definition is saved: a failed save leaves
    // it pending and the draft as it was.
    if (written !== null) {
      await settleProposal(written);
    }
  }

  // The latest save, for the keyboard shortcut.
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const command = event.metaKey || event.ctrlKey;
      if (!command) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
          return;
        }
        undo();
      }
      if (key === "s") {
        event.preventDefault();
        void saveRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Hydrate an unsaved local draft for this workflow on mount.
  useEffect(() => {
    draftHydratedRef.current = true;
    const base = savedRef.current;
    if (base === null) {
      return;
    }
    const stored = readWorkflowDraft(workflowId);
    if (stored === null) {
      return;
    }
    if (sameDefinition(stored.definition, base)) {
      clearWorkflowDraft(workflowId);
      return;
    }
    setDefinition(stored.definition);
    definitionRef.current = stored.definition;
    setRestoredDraftAt(stored.updatedAt);
  }, [workflowId]);

  // Persist unsaved edits locally so returning to the overview or refreshing never loses work.
  useEffect(() => {
    if (!draftHydratedRef.current) {
      return;
    }
    if (dirty && definition !== null) {
      writeWorkflowDraft(workflowId, definition);
    } else {
      clearWorkflowDraft(workflowId);
      setRestoredDraftAt(null);
    }
  }, [workflowId, definition, dirty]);

  // Warn before losing unapplied DSL editor text on reload/tab close (applied edits persist locally).
  useEffect(() => {
    if (dslPending !== "edited") {
      return;
    }
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dslPending]);

  const graph = useMemo(() => {
    if (definition === null) {
      return null;
    }
    try {
      return toEditorGraph(definition);
    } catch {
      return null;
    }
  }, [definition]);
  const humanForms = useMemo(() => {
    const map: Record<string, AskQuestionInput> = {};
    if (definition === null) {
      return map;
    }
    for (const n of definition.nodes) {
      if (n.type !== "human") {
        continue;
      }
      if (n.form !== undefined || n.question !== undefined) {
        map[n.id] = formToQuestions(n.form, n.question);
      }
    }
    return map;
  }, [definition]);
  const meta = definition?.meta;
  const panes = visiblePanes(width, sides, pane);

  // The PA's pending proposal, read every two seconds while the editor is open. It is handled
  // once per row: one that says what is saved is left alone, one that differs loads as an
  // unsaved draft only over a clean draft, and nothing here writes.
  const proposalQuery = useQuery(workflowProposalQuery(workflowId, saved !== null));
  const proposal = proposalQuery.data?.proposal ?? null;
  const seenRef = useRef<string | null>(null);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const cleanRef = useRef<boolean | null>(null);
  cleanRef.current = !dirty;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new proposal row is the only trigger
  useEffect(() => {
    const step = proposalStep({
      proposal,
      seenId: seenRef.current,
      saved: savedRef.current,
      clean: cleanRef.current === true,
    });
    if (step.kind === "ignore") {
      return;
    }
    seenRef.current = step.kind === "load" ? step.id : (proposal?.id ?? null);
    if (step.kind === "load") {
      setDefinitionTracked(step.draft);
      setLoadedId(step.id);
    }
  }, [proposal]);

  const settledId = settled === null ? null : settled.id;
  const notice: ProposalNotice = proposalNotice({ proposal, saved, loadedId, dirty, settledId });
  const proposalLines =
    proposal === null
      ? []
      : describeProposal("workflow_definition", proposal.payload, {
          agentNameOf: (id: string) => id,
        });

  function loadProposal(): void {
    if (proposal === null) {
      return;
    }
    const next = definitionOf(proposal.payload);
    if (next === null) {
      return;
    }
    setDefinitionTracked(next);
    setLoadedId(proposal.id);
    seenRef.current = proposal.id;
  }

  /** Says on its row what the save did with the proposal the editor had loaded: adopted when what
   *  was saved is that proposal, the one decision the server records for a workflow; discarded
   *  when the person changed the graph first. A proposal that was never loaded is not touched.
   *  The save is already done, so a refused or failed call changes nothing here but the toast. */
  async function settleProposal(written: WorkflowDefinition): Promise<void> {
    if (proposal === null || loadedId !== proposal.id) {
      return;
    }
    const settlement = settlementOf(written, proposal);
    if (settlement === null) {
      return;
    }
    try {
      await api.resolveProposal(proposal.id, settlement);
      setSettled({ id: proposal.id, decision: settlement });
      void proposalQuery.refetch();
      void qc.invalidateQueries({ queryKey: proposalKeys.pending });
    } catch {
      toast.warning(t("Saved. The PA's suggestion could not be recorded."));
    }
  }

  function offerDraft(): void {
    const count = (draft?.n ?? 0) + 1;
    const described = meta?.description ?? "";
    let goal = described;
    if (described === "") {
      goal = meta?.name ?? workflowId;
    }
    const text = workflowRequest(workflowId, goal, "");
    setDraft({ text, n: count });
  }

  function openSide(side: SidePanel): void {
    if (width === "wide") {
      setSides((current) => ({ ...current, [side]: true }));
      return;
    }
    if (width === "mid") {
      setSides({ node: side === "node", pa: side === "pa" });
      return;
    }
    setPane(side);
    setSides((current) => choosePane(current, side));
  }

  function switchPane(next: EditorPane): void {
    setPane(next);
    setSides((current) => choosePane(current, next));
  }

  /** The side-panel switches: three segments below 1024px, a toggle per panel above. */
  function switchPanel(target: SidePanel): void {
    if (width === "narrow") {
      switchPane(target);
      return;
    }
    setSides((current) => toggleSide(width, current, target));
  }

  function selectNode(id: string): void {
    setActiveId(id);
    setActiveEdgeIndex(null);
    setInspectorTab("attrs");
    if (width !== "narrow") {
      openSide("node");
    }
  }

  function selectEdge(index: number): void {
    setActiveEdgeIndex(index);
    setActiveId(null);
    setInspectorTab("attrs");
    if (width !== "narrow") {
      openSide("node");
    }
  }

  function addFromPalette(node: WorkflowNode): void {
    if (definition === null) {
      return;
    }
    const id = makeNodeId(node.type);
    setDefinitionTracked(addNode(definition, { ...node, id }));
    selectNode(id);
  }

  async function validate(): Promise<void> {
    if (definition === null) {
      return;
    }
    try {
      const res = await api.validateWorkflowDefinition({
        workflowId,
        definition: { ...definition } as Record<string, unknown>,
      });
      const notes: string[] = [];
      if (res.scriptNodesBlocked) {
        notes.push(t("Script nodes are disabled by WORKFLOW_SCRIPTS_ENABLED"));
      }
      if (res.risk && res.risk.reasons.length > 0) {
        notes.push(
          t("PA changes require approval for: {reasons}", {
            reasons: res.risk.reasons.join(", "),
          }),
        );
      }
      setValidation({
        ok: res.valid,
        ...(res.issues.length > 0 ? { errors: res.issues } : {}),
        ...(notes.length > 0 ? { notes } : {}),
      });
    } catch {
      try {
        parseWorkflow(definition);
        setValidation({ ok: true });
      } catch (err) {
        const fallback = err instanceof Error ? err.message : String(err);
        const issues = err instanceof WorkflowParseError ? err.issues : [fallback];
        setValidation({ ok: false, errors: issues });
      }
    }
  }

  async function openHistory(): Promise<void> {
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      const res = await api.getWorkflowHistory(workflowId, 20);
      setHistoryItems(res.history ?? []);
    } catch (err) {
      toast.error(t("Failed to load history"), {
        description: err instanceof Error ? err.message : String(err),
      });
      setHistoryItems([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function revertToCommit(commit: string): Promise<void> {
    const ok = await confirm({
      title: t("Revert workflow to {commit}?", { commit: commit.slice(0, 8) }),
      description: t(
        "This writes the selected revision as a new git commit and updates the active workflow.",
      ),
      confirmText: t("Revert"),
      destructive: true,
    });
    if (!ok) return;
    setRevertingCommit(commit);
    try {
      const res = await api.revertWorkflowDefinition(workflowId, commit);
      const next = res.definition as WorkflowDefinition;
      setSaved(next);
      setDefinition(next);
      definitionRef.current = next;
      clearWorkflowDraft(workflowId);
      setRestoredDraftAt(null);
      setHistoryOpen(false);
      toast.success(t("Workflow reverted"));
    } catch (err) {
      toast.error(t("Revert failed"), {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRevertingCommit(null);
    }
  }

  function discardLocalDraft(): void {
    if (saved === null) {
      return;
    }
    clearWorkflowDraft(workflowId);
    setDefinition(saved);
    definitionRef.current = saved;
    setPast([]);
    setFuture([]);
    setRestoredDraftAt(null);
    toast.success(t("Local draft discarded"));
  }

  function guardLeave(event: MouseEvent): void {
    if (dslPending !== "edited") {
      return;
    }
    event.preventDefault();
    const options = {
      title: t("Discard unsaved changes?"),
      description: t("You have unapplied DSL edits. Leaving will lose the unapplied text."),
      confirmText: t("Leave"),
      cancelText: t("Stay"),
      destructive: true,
    };
    void confirm(options).then((ok) => {
      if (ok) {
        router.push(`/workflows/${workflowId}`);
      }
    });
  }

  let canvasArea: ReactNode = (
    <p className="p-6 text-sm text-(--mute)">
      {t("This file is not a workflow definition, so there is nothing to edit here.")}
    </p>
  );
  if (graph !== null) {
    canvasArea = (
      <div className="flex h-full min-h-0 flex-col">
        <DagStatsBar
          nodeCount={graph.nodes.length}
          depth={graph.nodes.reduce((m, n) => Math.max(m, n.layer), 0) + 1}
          validated={validation?.ok === true}
          streaming={false}
          zoom={zoom ?? undefined}
        />
        <div className="min-h-0 flex-1">
          {menu && (
            <div className="fixed z-50" style={{ left: menu.x, top: menu.y }}>
              <NodeMenuPopover
                onPick={(node) => {
                  if (definition === null) {
                    return;
                  }
                  const id = makeNodeId(node.type);
                  setDefinitionTracked(
                    addNode(addEdge(definition, menu.sourceId, id), { ...node, id }),
                  );
                  selectNode(id);
                }}
                onClose={() => setMenu(null)}
              />
            </div>
          )}
          <WorkflowCanvas
            graph={graph}
            interactive
            onSelect={selectNode}
            onConnect={(from, to) => {
              if (definition !== null) {
                setDefinitionTracked(addEdge(definition, from, to));
              }
            }}
            onNodeDelete={(id) => {
              if (definition !== null) {
                setDefinitionTracked(deleteNode(definition, id));
              }
            }}
            onEdgeSelect={selectEdge}
            onNodeMenuRequested={(sourceId, position) =>
              setMenu({ sourceId, x: position.x, y: position.y })
            }
            onReady={setZoom}
            humanForms={humanForms}
          />
        </div>
      </div>
    );
  }

  let inspector: ReactNode = (
    <p className="p-4 text-xs text-(--mute)">
      {t("Select a node or an edge to edit it, or open Nodes to add one.")}
    </p>
  );
  if (definition !== null) {
    if (inspectorTab === "triggers") {
      inspector = <TriggerPanel definition={definition} onChange={setDefinitionTracked} />;
    } else if (inspectorTab === "palette") {
      inspector = <NodePanel onAdd={addFromPalette} />;
    } else if (activeEdgeIndex !== null) {
      inspector = (
        <EdgePropertyPanel
          edgeIndex={activeEdgeIndex}
          definition={definition}
          onChange={setDefinitionTracked}
          onDelete={(next) => {
            setDefinitionTracked(next);
            setActiveEdgeIndex(null);
          }}
        />
      );
    } else if (activeId !== null) {
      inspector = (
        <NodePropertyPanel
          workflowId={workflowId}
          nodeId={activeId}
          definition={definition}
          onChange={setDefinitionTracked}
        />
      );
    }
  }

  const canSave = dirty && definition !== null && saving === "idle" && dslPending === "clean";
  const sideWidth = width === "wide" ? "" : "w-[320px]";
  const proposalHidden = notice === "aside" && !panes.pa;
  const settledDecision = settled === null ? "discarded" : settled.decision;

  const proposalPanel =
    notice === "none" ? null : (
      <div
        role="status"
        className="max-h-[45%] shrink-0 space-y-2 overflow-y-auto border-b border-(--hairline) px-4 py-3 text-[11px]"
      >
        {notice === "saved" && (
          <p className="text-(--primary)">
            {t("The PA's pending proposal says what is already saved. There is nothing to load.")}
          </p>
        )}
        {notice === "in-draft" && (
          <p className="text-(--warn)">
            {t(
              "A proposal from the PA is on the canvas as an unsaved draft. Save keeps it; Undo brings the saved definition back.",
            )}
          </p>
        )}
        {notice === "aside" && (
          <div className="space-y-2">
            <p className="text-(--warn)">
              {dirty
                ? t(
                    "A proposal from the PA is waiting. Your unsaved edits come first; loading it replaces them, and Undo brings them back.",
                  )
                : t("A proposal from the PA is waiting. It is not on the canvas yet.")}
            </p>
            <Button size="xs" variant="outline" onClick={loadProposal}>
              {t("Load the proposal")}
            </Button>
          </div>
        )}
        {notice === "settled" && (
          <p className="text-(--primary)">
            {settledDecision === "adopted"
              ? t("The proposal was recorded as adopted: the saved definition is that proposal.")
              : t("The proposal was recorded as discarded: the saved definition differs from it.")}
          </p>
        )}
        <ul className="space-y-0.5 font-mono text-[10px] text-(--faint)">
          {proposalLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="text-[10px] text-(--faint)">
          {t(
            "Saving settles a proposal that is on the canvas: adopted when what you saved is that proposal, discarded when you changed it first. One that was never loaded stays pending until it is discarded from the Proposals inbox.",
          )}
        </p>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-(--canvas) text-(--ink)">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-(--hairline) px-4">
        <Link
          href={`/workflows/${workflowId}`}
          onClick={guardLeave}
          className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-(--mute) hover:text-(--primary)"
        >
          <ArrowLeft className="size-3.5" />
          {t("Overview")}
        </Link>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[1.8px] text-(--faint)">
          {workflowId} · {t("Editor")}
        </span>
        <span className="min-w-0 truncate text-sm font-[550] text-(--ink)">
          {meta?.name ?? workflowId}
        </span>
        {meta?.status && <Badge variant="secondary">{meta.status}</Badge>}
        <Badge variant={dirty ? "wait" : "secondary"}>
          {dirty ? t("Unsaved changes") : t("Saved")}
        </Badge>
        {proposalHidden && (
          <Button size="sm" variant="violet" onClick={() => openSide("pa")}>
            {t("PA proposal waiting")}
          </Button>
        )}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("Undo")}
          title={t("Undo")}
          disabled={past.length === 0}
          onClick={undo}
        >
          <Undo2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("Redo")}
          title={t("Redo")}
          disabled={future.length === 0}
          onClick={redo}
        >
          <Redo2 />
        </Button>
        <div
          role="group"
          aria-label={t("Editor mode")}
          className="flex overflow-hidden rounded-md border border-(--hairline)"
        >
          <Segment
            label={t("Canvas")}
            pressed={mode === "canvas"}
            onClick={() => setMode("canvas")}
          />
          <Segment label={t("DSL")} pressed={mode === "dsl"} onClick={() => setMode("dsl")} />
        </div>
        <Button size="sm" variant="ghost" onClick={() => void openHistory()}>
          <History className="size-3.5" />
          {t("History")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void validate()}>
          {t("Validate")}
        </Button>
        <Button size="sm" disabled={!canSave} onClick={() => void save()}>
          {saving === "busy" ? t("Saving…") : t("Save")}
        </Button>
      </header>

      {restoredDraftAt !== null && dirty && (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center gap-3 border-b border-(--warn)/25 bg-(--warn)/8 px-4 py-1.5 text-xs text-(--warn)"
        >
          <span className="min-w-0 flex-1">
            {t(
              "Restored your unsaved local draft. Save writes it; Discard returns to the saved definition.",
            )}
          </span>
          <Button size="xs" variant="outline" onClick={discardLocalDraft}>
            {t("Discard draft")}
          </Button>
        </div>
      )}

      {validation && (
        <div
          role="status"
          className={cn(
            "flex shrink-0 flex-wrap items-start gap-x-4 gap-y-1 border-b px-4 py-1.5 text-xs",
            validation.ok
              ? "border-(--primary)/30 bg-(--primary)/10 text-(--primary)"
              : "border-(--err)/30 bg-(--err)/10 text-(--err)",
          )}
        >
          <span>{validation.ok ? t("Valid definition") : t("Invalid definition")}</span>
          {!validation.ok && (
            <span className="font-mono">{(validation.errors ?? []).join("; ")}</span>
          )}
          {validation.notes && validation.notes.length > 0 && (
            <span className="font-mono text-(--warn)">{validation.notes.join(" · ")}</span>
          )}
        </div>
      )}

      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-(--hairline) px-4">
        <p className="min-w-0 flex-1 truncate text-[11px] text-(--mute)">
          {t(
            "Canvas ↔ node fields ↔ PA suggestions. A suggestion becomes an unsaved draft; Save is what writes.",
          )}
        </p>
        <div
          role="group"
          aria-label={t("Editor panels")}
          className="flex gap-[3px] rounded-[7px] border border-(--hairline) p-[3px]"
        >
          {width === "narrow" && (
            <Segment
              label={t("Canvas")}
              pressed={pane === "canvas"}
              onClick={() => switchPane("canvas")}
            />
          )}
          <Segment
            label={t("Node inspector")}
            pressed={panes.node}
            onClick={() => switchPanel("node")}
          />
          <Segment label={t("PA session")} pressed={panes.pa} onClick={() => switchPanel("pa")} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {panes.canvas && (
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {mode === "dsl"
              ? definition !== null && (
                  <DslEditorPanel
                    definition={definition}
                    onChange={setDefinitionTracked}
                    onPendingChange={(pending) => setDslPending(pending ? "edited" : "clean")}
                  />
                )
              : canvasArea}
          </main>
        )}
        {panes.node && (
          <aside
            aria-label={t("Node inspector")}
            className={cn(
              "flex min-h-0 shrink-0 flex-col border-l border-(--hairline) bg-(--panel)",
              sideWidth === "" ? "w-[300px]" : sideWidth,
            )}
          >
            <div
              role="tablist"
              aria-label={t("Inspector")}
              className="flex shrink-0 border-b border-(--hairline)"
            >
              {INSPECTOR_TABS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={inspectorTab === key}
                  onClick={() => setInspectorTab(key)}
                  className={cn(
                    "flex-1 px-2 py-2.5 text-xs transition-colors",
                    inspectorTab === key
                      ? "border-b-2 border-(--primary) text-(--ink)"
                      : "text-(--mute) hover:text-(--ink)",
                  )}
                >
                  {t(label)}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">{inspector}</div>
          </aside>
        )}
        {panes.pa && (
          <aside
            aria-label={t("PA session")}
            className={cn(
              "flex min-h-0 shrink-0 flex-col border-l border-(--hairline) bg-(--panel)",
              sideWidth === "" ? "w-[360px]" : sideWidth,
            )}
          >
            <PaSession
              origin="editor:workflow"
              sessionKey={`workflow-editor:${workflowId}`}
              skillSpec={{
                fallbackCommand: "/workflow_design",
                matchKeyword: "workflow",
                fallbackDescription: t("Modify this workflow"),
                contextLine: `${t("Workflow")}: ${meta?.name ?? workflowId} (${workflowId})`,
              }}
              draft={draft ?? undefined}
              headerAction={
                <Button type="button" variant="ghost" size="sm" onClick={offerDraft}>
                  <Wand2 className="size-3.5" />
                  {t("Draft a request")}
                </Button>
              }
              emptyTitle={t("Ask the PA to change this workflow")}
            >
              {proposalPanel}
            </PaSession>
          </aside>
        )}
      </div>
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              {t("Version history: {workflowId}", { workflowId })}
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {historyLoading ? (
              <p className="text-xs text-(--mute)">{t("Loading…")}</p>
            ) : historyItems.length === 0 ? (
              <p className="text-xs text-(--mute)">{t("No recorded commits yet.")}</p>
            ) : (
              historyItems.map((entry) => (
                <div
                  key={entry.commit}
                  className="flex items-start justify-between gap-3 rounded-lg border border-(--hairline) bg-(--canvas)/60 p-2.5 text-xs"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="wrap-break-word font-medium text-(--ink)">{entry.summary}</p>
                    <p className="font-mono text-[10px] text-(--faint)">
                      {entry.commit.slice(0, 8)} · {entry.author} ·{" "}
                      {new Date(entry.timestamp).toLocaleString()}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={revertingCommit === entry.commit}
                    onClick={() => void revertToCommit(entry.commit)}
                  >
                    <RotateCcw className="size-3" />
                    {t("Revert")}
                  </Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </div>
  );
}
