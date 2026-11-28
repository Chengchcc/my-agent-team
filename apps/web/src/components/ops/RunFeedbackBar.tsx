"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, ThumbsDown, ThumbsUp } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { evalKeys, useEvalSuites, useRunFeedback } from "@/features/ops/eval-queries";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

const FEEDBACK_TAGS = [
  "wrong_tool",
  "missed_skill",
  "wrong_route",
  "hallucination",
  "slow",
] as const;

/** ADR 0085 D7: Human thumbs-up/down annotation + one-click "Add to Eval Suite"
 *  flywheel mounted on `/system/runs/[runId]` and workflow execution views. */
export function RunFeedbackBar({
  runId,
  workflowExecutionId,
}: {
  runId?: string;
  workflowExecutionId?: string;
}) {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [suiteId, setSuiteId] = useState("prod-regressions");
  const [caseName, setCaseName] = useState("");
  const [expectedContains, setExpectedContains] = useState("");

  const queryClient = useQueryClient();
  const feedbackQuery = useRunFeedback({ runId, workflowExecutionId });
  const suitesQuery = useEvalSuites();

  const feedbackMutation = useMutation({
    mutationFn: (rating: "up" | "down") =>
      api.saveRunFeedback({
        runId,
        workflowExecutionId,
        rating,
        tags: selectedTags,
        note: note.trim() || null,
      }),
    onSuccess: () => {
      toast.success(t("Feedback saved"));
      setNote("");
      void queryClient.invalidateQueries({
        queryKey: evalKeys.feedback({ runId, workflowExecutionId }),
      });
    },
    onError: () => toast.error(t("Failed to save feedback")),
  });

  const promoteMutation = useMutation({
    mutationFn: () =>
      api.promoteRunToEval({
        runId,
        workflowExecutionId,
        suiteId: suiteId.trim(),
        caseName: caseName.trim() || undefined,
        tags: selectedTags,
        note: note.trim() || undefined,
        expectedContains: expectedContains.trim() || undefined,
      }),
    onSuccess: (res) => {
      toast.success(t("Added to eval suite {suite}", { suite: res.suite.id }));
      setPromoteOpen(false);
      void queryClient.invalidateQueries({ queryKey: evalKeys.all });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : t("Failed to promote case")),
  });

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag],
    );
  };

  const existing = feedbackQuery.data?.feedback ?? [];
  const suites = suitesQuery.data?.suites ?? [];

  return (
    <section className="rounded-2xl border border-white/6 bg-(--panel) p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[10px] tracking-[1.8px] uppercase text-(--faint)">
          {t("Quality feedback & eval flywheel")}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={feedbackMutation.isPending}
            onClick={() => feedbackMutation.mutate("up")}
          >
            <ThumbsUp className="size-3.5 text-(--ok)" />
            {t("Good")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={feedbackMutation.isPending}
            onClick={() => feedbackMutation.mutate("down")}
          >
            <ThumbsDown className="size-3.5 text-(--err)" />
            {t("Needs fix")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              if (suites[0] && suiteId === "prod-regressions") setSuiteId(suites[0].id);
              setPromoteOpen(true);
            }}
          >
            <FlaskConical className="size-3.5" />
            {t("Add to eval suite")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {FEEDBACK_TAGS.map((tag) => {
          const active = selectedTags.includes(tag);
          return (
            <Button
              key={tag}
              type="button"
              size="sm"
              variant={active ? "default" : "outline"}
              className="h-6 px-2 font-mono text-[10px]"
              onClick={() => toggleTag(tag)}
            >
              {tag}
            </Button>
          );
        })}
      </div>

      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t("Optional diagnosis note (stored with feedback or promoted case)…")}
      />

      {existing.length > 0 && (
        <div className="space-y-1.5 border-t border-(--hairline) pt-2.5">
          {existing.map((fb) => (
            <div
              key={fb.feedbackId}
              className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-(--mute)"
            >
              <span className={fb.rating === "up" ? "text-(--ok)" : "text-(--err)"}>
                {fb.rating === "up" ? "👍" : "👎"}
              </span>
              {fb.tags.map((tg) => (
                <span
                  key={tg}
                  className="rounded border border-(--hairline) px-1.5 py-0.5 text-[10px]"
                >
                  {tg}
                </span>
              ))}
              {fb.note && <span className="text-(--ink)">{fb.note}</span>}
              {fb.promotedSuiteId && (
                <Link
                  href={`/system/evals?suite=${encodeURIComponent(fb.promotedSuiteId)}`}
                  className="text-(--primary) hover:underline"
                >
                  → {fb.promotedSuiteId}/{fb.promotedCaseId}
                </Link>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={promoteOpen} onOpenChange={setPromoteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Promote to eval case")}</DialogTitle>
            <DialogDescription>
              {t(
                "Saves this execution's input and detected skill/workflow assertions into a Git-versioned eval suite.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label>{t("Target suite ID")}</Label>
              <Input
                value={suiteId}
                onChange={(e) => setSuiteId(e.target.value)}
                placeholder="prod-regressions"
              />
              {suites.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {suites.slice(0, 5).map((s) => (
                    <Button
                      key={s.id}
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1.5 font-mono text-[10px]"
                      onClick={() => setSuiteId(s.id)}
                    >
                      {s.id}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <Label>{t("Case name (optional)")}</Label>
              <Input
                value={caseName}
                onChange={(e) => setCaseName(e.target.value)}
                placeholder="Regression case title"
              />
            </div>
            <div>
              <Label>{t("Expected output substring (optional)")}</Label>
              <Textarea
                rows={2}
                value={expectedContains}
                onChange={(e) => setExpectedContains(e.target.value)}
                placeholder="Keyword or phrase the answer must include"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPromoteOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button
              disabled={!suiteId.trim() || promoteMutation.isPending}
              onClick={() => promoteMutation.mutate()}
            >
              <FlaskConical className="size-3.5" />
              {t("Save eval case")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
