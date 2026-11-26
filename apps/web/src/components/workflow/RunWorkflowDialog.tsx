"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { artifactsQuery } from "@/features/artifacts/queries";
import { inputKindOf, runInput } from "@/features/workflow/draft";
import type { RunBlock } from "@/features/workflow/list-facts";
import { definitionOf } from "@/features/workflow/proposal-draft";
import { workflowDefinitionQuery } from "@/features/workflow/queries";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

const BLOCK_TEXT: Record<RunBlock, string> = {
  scripts:
    "This workflow runs a script node, and scripts are disabled on this server. It can be edited here, not run.",
  invalid:
    "This definition does not parse, so the server will not run it. Open the editor to fix it.",
  running: "A run of this workflow is still going. The server refuses a second one until it ends.",
};

const ARTIFACT_LIST_ID = "run-artifact-suggestions";

export interface RunWorkflowDialogProps {
  workflowId: string;
  /** The name the title shows. */
  name: string;
  open: boolean;
  onClose: () => void;
  /** Why Run is closed, or null when it is open. The dialog still opens, to say why. */
  blocked: RunBlock | null;
  /** A run of the workflow was started. */
  onStarted?: (workflowId: string) => void;
}

/** Starts one execution of the saved definition. It is a separate action from saving and from
 *  enabling a schedule: the dialog writes nothing of its own, and the inputs are the definition's
 *  own parameters. */
export function RunWorkflowDialog({
  workflowId,
  name,
  open,
  onClose,
  blocked,
  onStarted,
}: RunWorkflowDialogProps) {
  const definitionQuery = useQuery({ ...workflowDefinitionQuery(workflowId), enabled: open });
  const [values, setValues] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<"idle" | "starting">("idle");
  const definition =
    definitionQuery.data === undefined ? null : definitionOf(definitionQuery.data.definition);
  const params = definition?.input ?? [];
  const needsArtifacts = params.some((param) => inputKindOf(param.type) === "artifact");
  const artifactsList = useQuery({ ...artifactsQuery(), enabled: open && needsArtifacts });
  const artifactUrls = (artifactsList.data?.artifacts ?? []).map((artifact) => artifact.url);

  // Every opening starts with empty fields: a run's inputs are not a draft that carries over.
  useEffect(() => {
    if (open) {
      setValues({});
    }
  }, [open]);

  async function start(): Promise<void> {
    if (definition === null) {
      return;
    }
    if (blocked !== null) {
      return;
    }
    if (phase === "starting") {
      return;
    }
    setPhase("starting");
    try {
      const sent = runInput(definition.input ?? [], values);
      await api.startWorkflowExecution({
        workflowRef: { path: `${workflowId}.workflow.json` },
        input: sent.input,
        artifacts: sent.artifacts,
      });
      toast.success(t("Execution started"));
      onClose();
      onStarted?.(workflowId);
    } catch (err) {
      toast.error(t("Run failed"), {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPhase("idle");
    }
  }

  const canStart = definition !== null && blocked === null && phase === "idle";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Run {name}", { name })}</DialogTitle>
          <DialogDescription>
            {t("Starts one execution of the saved definition. Nothing is saved or enabled by it.")}
          </DialogDescription>
        </DialogHeader>
        {definitionQuery.isPending && (
          <p className="text-xs text-(--mute)">{t("Loading the definition…")}</p>
        )}
        {definitionQuery.isError && (
          <p role="alert" className="text-xs text-(--err)">
            {t("The definition could not be read.")}
          </p>
        )}
        {definition !== null && (
          <div className="space-y-3">
            {params.length === 0 && (
              <p className="text-xs text-(--mute)">{t("This workflow has no input parameters.")}</p>
            )}
            {params.map((param, index) => {
              const kind = inputKindOf(param.type);
              const placeholder = kind === "boolean" ? t("true / false") : "";
              return (
                <div key={`${param.key}-${index}`} className="flex flex-col gap-1">
                  <Label className="text-xs text-(--mute)">
                    <span className="font-mono">{param.key}</span>{" "}
                    <span className="font-normal text-(--faint)">({kind})</span>
                  </Label>
                  <Input
                    list={kind === "artifact" ? ARTIFACT_LIST_ID : undefined}
                    type={kind === "number" ? "number" : "text"}
                    placeholder={placeholder}
                    value={values[param.key] ?? ""}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [param.key]: event.target.value }))
                    }
                  />
                </div>
              );
            })}
            {needsArtifacts && (
              <datalist id={ARTIFACT_LIST_ID}>
                {artifactUrls.map((url) => (
                  <option key={url} value={url} />
                ))}
              </datalist>
            )}
          </div>
        )}
        {blocked !== null && (
          <p
            role="alert"
            className="rounded-md border border-(--warn)/40 bg-(--warn)/10 px-2 py-1.5 text-xs text-(--warn)"
          >
            {t(BLOCK_TEXT[blocked])}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button disabled={!canStart} onClick={() => void start()}>
            {phase === "starting" ? t("Starting…") : t("Run")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
