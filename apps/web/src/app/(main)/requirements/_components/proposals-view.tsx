"use client";

import { CheckCircle2, Code2, Inbox, Play, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAgentList } from "@/features/agents/hooks";
import { useProjectList } from "@/features/projects/hooks";
import { describeProposal, proposalTitle } from "@/features/proposals/describe";
import {
  type PendingProposal,
  useAdoptProposal,
  useDiscardProposal,
  usePendingProposals,
} from "@/features/proposals/hooks";
import {
  appliesFromInbox,
  owningEditorHref,
  PROPOSAL_KIND_LABELS,
  PROPOSAL_KINDS,
  resourcePageHref,
} from "@/features/proposals/queries";
import { definitionOf, workflowProposalMeta } from "@/features/workflow/proposal-draft";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

/** Why a kind has no Adopt button here, or what Adopt does. */
function reviewNote(kind: PendingProposal["kind"]): string {
  if (kind === "agent_config") {
    return t(
      "Adopting from here would write the agent at once. Review the suggestion in the agent editor; applying it there only fills the form.",
    );
  }
  if (kind === "workflow_definition") {
    return t(
      "Validate and test any proposed scripts here, then click Adopt to apply and record a git commit, or open in the workflow editor.",
    );
  }
  return t("Adopting applies the proposal now.");
}

function WorkflowProposalVerifier({ proposal }: { proposal: PendingProposal }) {
  const def = definitionOf(proposal.payload);
  const meta = workflowProposalMeta(proposal.payload);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{
    valid: boolean;
    issues: string[];
    scriptNodesBlocked: boolean;
  } | null>(null);
  const [expandedScriptId, setExpandedScriptId] = useState<string | null>(null);
  const [scriptInputs, setScriptInputs] = useState<Record<string, string>>({});
  const [scriptResults, setScriptResults] = useState<Record<string, string>>({});
  const [testingScriptId, setTestingScriptId] = useState<string | null>(null);

  if (def === null) return null;

  const scriptNodes =
    meta && meta.scriptNodes.length > 0
      ? meta.scriptNodes
      : def.nodes
          .filter(
            (n): n is Extract<(typeof def.nodes)[number], { type: "script" }> =>
              n.type === "script",
          )
          .map((n) => {
            const label = (n as { label?: string }).label;
            return {
              id: n.id,
              code: n.code,
              ...(label ? { label } : {}),
              ...(n.timeoutMs ? { timeoutMs: n.timeoutMs } : {}),
            };
          });
  const reasons = meta?.requiresApprovalFor ?? [];

  async function runValidate(): Promise<void> {
    if (def === null) return;
    setValidating(true);
    try {
      const res = await api.validateWorkflowDefinition({
        workflowId: proposal.targetId,
        definition: { ...def } as Record<string, unknown>,
      });
      setValidation({
        valid: res.valid,
        issues: res.issues ?? [],
        scriptNodesBlocked: Boolean(res.scriptNodesBlocked),
      });
    } catch (err) {
      setValidation({
        valid: false,
        issues: [err instanceof Error ? err.message : String(err)],
        scriptNodesBlocked: false,
      });
    } finally {
      setValidating(false);
    }
  }

  async function runScriptTest(node: {
    id: string;
    code: string;
    timeoutMs?: number;
  }): Promise<void> {
    setTestingScriptId(node.id);
    try {
      const raw = (scriptInputs[node.id] ?? "").trim();
      const input = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const res = await api.testWorkflowScript({
        code: node.code,
        input,
        timeoutMs: node.timeoutMs,
      });
      const lines = [
        `status=${res.ok ? "ok" : "failed"} exitCode=${res.exitCode} duration=${res.durationMs}ms`,
      ];
      if (res.output !== undefined) lines.push(`output: ${JSON.stringify(res.output, null, 2)}`);
      if (res.stdout) lines.push(`stdout:\n${res.stdout}`);
      if (res.stderr) lines.push(`stderr:\n${res.stderr}`);
      setScriptResults((prev) => ({ ...prev, [node.id]: lines.join("\n") }));
    } catch (err) {
      setScriptResults((prev) => ({
        ...prev,
        [node.id]: t("Error: {message}", {
          message: err instanceof Error ? err.message : String(err),
        }),
      }));
    } finally {
      setTestingScriptId(null);
    }
  }

  return (
    <div className="mt-3 space-y-2.5 rounded-lg border border-(--hairline) bg-(--canvas)/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {reasons.includes("script") && (
            <Badge variant="wait" className="gap-1 text-[10px]">
              <Code2 className="size-3" />
              {t("Script approval")}
            </Badge>
          )}
          {reasons.includes("cron") && (
            <Badge variant="wait" className="gap-1 text-[10px]">
              <ShieldAlert className="size-3" />
              {t("Cron approval")}
            </Badge>
          )}
        </div>
        <Button
          size="xs"
          variant="outline"
          disabled={validating}
          onClick={() => void runValidate()}
        >
          <CheckCircle2 className="size-3" />
          {validating ? t("Validating…") : t("Validate")}
        </Button>
      </div>

      {validation && (
        <div
          className={`rounded border px-2.5 py-1.5 font-mono text-[10px] ${
            validation.valid
              ? "border-(--primary)/30 bg-(--primary)/10 text-(--primary)"
              : "border-(--err)/30 bg-(--err)/10 text-(--err)"
          }`}
        >
          <p>{validation.valid ? t("Validation passed") : t("Validation failed")}</p>
          {validation.issues.length > 0 && (
            <p className="mt-1 whitespace-pre-wrap">{validation.issues.join("\n")}</p>
          )}
          {validation.scriptNodesBlocked && (
            <p className="mt-1 text-(--warn)">
              {t("Script nodes are currently disabled by WORKFLOW_SCRIPTS_ENABLED.")}
            </p>
          )}
        </div>
      )}

      {scriptNodes.length > 0 && (
        <div className="space-y-2">
          {scriptNodes.map((node) => {
            const expanded = expandedScriptId === node.id;
            const result = scriptResults[node.id];
            return (
              <div
                key={node.id}
                className="rounded border border-(--hairline) bg-(--panel) p-2.5 text-[11px]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-(--ink)">
                    {node.label ? `${node.label} (${node.id})` : node.id}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setExpandedScriptId(expanded ? null : node.id)}
                  >
                    {expanded ? t("Hide script") : t("Inspect & test")}
                  </Button>
                </div>
                {expanded && (
                  <div className="mt-2 space-y-2">
                    <pre className="max-h-44 overflow-auto rounded bg-(--canvas) p-2 font-mono text-[10px] text-(--body)">
                      {node.code}
                    </pre>
                    <div className="space-y-1">
                      <Label className="text-[10px] text-(--mute)">{t("Test input (JSON)")}</Label>
                      <Textarea
                        className="min-h-14 border-(--hairline) bg-(--canvas) font-mono text-[10px]"
                        placeholder="{}"
                        value={scriptInputs[node.id] ?? ""}
                        onChange={(e) =>
                          setScriptInputs((prev) => ({ ...prev, [node.id]: e.target.value }))
                        }
                      />
                    </div>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={testingScriptId === node.id}
                      onClick={() => void runScriptTest(node)}
                    >
                      <Play className="size-3" />
                      {testingScriptId === node.id ? t("Running…") : t("Test script in sandbox")}
                    </Button>
                    {result && (
                      <pre className="max-h-40 overflow-auto rounded bg-(--canvas) p-2 font-mono text-[10px] text-(--mute)">
                        {result}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The inbox of decisions waiting for a person (ADR 0040). Project proposals are adopted here
 *  and applied at once. Agent and workflow proposals open in the editor that owns them. */
export function ProposalsView() {
  const pending = usePendingProposals();
  const agents = useAgentList();
  const projects = useProjectList();
  const adopt = useAdoptProposal();
  const discard = useDiscardProposal();
  const { confirm, dialog } = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows = pending.data?.proposals ?? [];
  const nameById = new Map((agents.data ?? []).map((agent) => [agent.id, agent.name] as const));
  const projectNameById = new Map(
    (projects.data?.projects ?? []).map((project) => [project.projectId, project.name] as const),
  );
  const ordered = [...rows].sort(
    (a, b) =>
      PROPOSAL_KINDS.indexOf(a.kind) - PROPOSAL_KINDS.indexOf(b.kind) || b.createdAt - a.createdAt,
  );

  function targetLabel(proposal: PendingProposal): string {
    const byKind = proposal.kind;
    if (byKind === "agent_config") return nameById.get(proposal.targetId) ?? proposal.targetId;
    if (byKind === "project_creation") return t("a new project");
    if (byKind === "project_update") {
      return projectNameById.get(proposal.targetId) ?? proposal.targetId;
    }
    return proposal.targetId;
  }

  function targetHref(proposal: PendingProposal): string | null {
    if (proposal.kind === "workflow_definition") return `/workflows/${proposal.targetId}`;
    if (proposal.kind === "project_update") return `/team/projects/${proposal.targetId}`;
    return null;
  }

  async function adoptNow(proposal: PendingProposal): Promise<void> {
    const ok = await confirm({
      title: t("Adopt and apply this proposal?"),
      description: t("Adopting applies the proposed values now. It cannot be undone from here."),
      confirmText: t("Adopt"),
    });
    if (!ok) return;
    setBusyId(proposal.id);
    adopt.mutate(proposal.id, { onSettled: () => setBusyId(null) });
  }

  async function discardNow(proposal: PendingProposal): Promise<void> {
    const ok = await confirm({
      title: t("Discard this proposal?"),
      description: t("The suggestion is dropped. Nothing it proposed is applied."),
      confirmText: t("Discard"),
      destructive: true,
    });
    if (!ok) return;
    setBusyId(proposal.id);
    discard.mutate(proposal.id, { onSettled: () => setBusyId(null) });
  }

  if (pending.isLoading) {
    return <p className="text-xs text-(--mute)">{t("Loading…")}</p>;
  }
  if (ordered.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title={t("Nothing waiting for a decision")}
        description={t(
          "Suggestions the PA files for an agent, a workflow or a project appear here until you adopt or discard them.",
        )}
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="rounded-[9px] border border-(--warn)/11 bg-(--warn)/3 px-[15px] py-[13px] text-[11px] leading-relaxed text-(--warn)">
        {t(
          "A proposal is a decision waiting for you. Viewing it changes nothing; adopt applies it, discard drops it.",
        )}
      </p>
      <ul className="grid gap-4 lg:grid-cols-2">
        {ordered.map((proposal) => {
          const body = describeProposal(proposal.kind, proposal.payload, {
            agentNameOf: (id) => nameById.get(id) ?? id,
          });
          const fromInbox = appliesFromInbox(proposal);
          const editorHref = owningEditorHref(proposal);
          const resourceHref = resourcePageHref(proposal.kind);
          const named = proposalTitle(proposal.kind, proposal.payload);
          const title = named === null ? targetLabel(proposal) : named;
          const lines = body;
          const pageHref = targetHref(proposal);
          const busy = busyId === proposal.id || adopt.isPending || discard.isPending;
          return (
            <li
              key={proposal.id}
              data-kind={proposal.kind}
              className="min-w-0 rounded-xl border border-(--hairline) bg-(--panel) p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge variant="secondary">{t(PROPOSAL_KIND_LABELS[proposal.kind])}</Badge>
                <Badge variant="wait">{t("Waiting for a decision")}</Badge>
              </div>
              <h3 className="mt-3 text-base font-[550] wrap-break-word text-(--ink)">{title}</h3>
              <p className="mt-1 text-[11px] text-(--mute)">
                {t("About")}:{" "}
                {pageHref === null ? (
                  <span className="font-mono">{targetLabel(proposal)}</span>
                ) : (
                  <Link href={pageHref} className="font-mono text-(--primary-deep) hover:underline">
                    {targetLabel(proposal)}
                  </Link>
                )}
                <span className="ml-2 font-mono text-[10px] text-(--faint)">
                  {new Date(proposal.createdAt).toLocaleString()}
                </span>
              </p>
              {lines.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {lines.map((line) => (
                    <li key={line} className="wrap-break-word font-mono text-[11px] text-(--body)">
                      {line}
                    </li>
                  ))}
                </ul>
              )}
              {proposal.kind === "workflow_definition" && (
                <WorkflowProposalVerifier proposal={proposal} />
              )}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {editorHref !== null && (
                  <Button variant="outline" size="sm" render={<Link href={editorHref} />}>
                    {proposal.kind === "agent_config"
                      ? t("Open in agent editor")
                      : t("Open in workflow editor")}
                  </Button>
                )}
                {fromInbox && (
                  <Button size="sm" disabled={busy} onClick={() => void adoptNow(proposal)}>
                    {t("Adopt")}
                  </Button>
                )}
                {resourceHref !== null && (
                  <Button variant="ghost" size="sm" render={<Link href={resourceHref} />}>
                    {t("View projects")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void discardNow(proposal)}
                >
                  {t("Discard")}
                </Button>
              </div>
              <p className="mt-3 text-[10px] leading-relaxed text-(--faint)">
                {reviewNote(proposal.kind)}
              </p>
            </li>
          );
        })}
      </ul>
      {dialog}
    </div>
  );
}
