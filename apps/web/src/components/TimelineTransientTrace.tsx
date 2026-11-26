"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { t } from "@/lib/i18n";
import type { LiveToolCall } from "@/lib/transient-reducer";
import { cn } from "@/lib/utils";
import { LiveToolStep } from "./LiveToolStep";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

interface TimelineTransientTraceProps {
  msgCount: number;
  thinking: string;
  tools: readonly LiveToolCall[];
  ordered?: ReadonlyArray<{ type: "text" | "thinking"; text: string }>;
}

/** Live trace for an active streaming run:
 *  - While running, shows a single compact live status bar (`● Running … ▾`)
 *    so the user always sees live progress without flooding the canvas.
 *  - Clicking expands to inspect real-time thinking fragments and live tool
 *    steps; once the run settles, `ReasoningTrace` takes over in its default
 *    collapsed state below the final answer. */
export function TimelineTransientTrace({ thinking, tools, ordered }: TimelineTransientTraceProps) {
  const [open, setOpen] = useState(false);

  const thinkingParts =
    ordered && ordered.length > 0
      ? ordered.filter((b) => b.type === "thinking" && b.text.trim().length > 0).map((b) => b.text)
      : thinking.trim()
        ? [thinking.trim()]
        : [];

  const runningTool = [...tools].reverse().find((tool) => tool.state === "running");
  const errorCount = tools.filter((tool) => tool.state === "error").length;

  let statusLine: string;
  if (runningTool) {
    statusLine = t("Running {tool} (step {n})…", {
      tool: runningTool.activity ?? runningTool.name,
      n: tools.length,
    });
  } else if (tools.length > 0) {
    statusLine = t("Completed {n} steps, thinking…", { n: tools.length });
  } else {
    statusLine = t("Thinking…");
  }

  const hasDetails = tools.length > 0 || thinkingParts.length > 0;

  return (
    <div data-slot="live-trace-bar" className="mt-2 min-w-0 w-full">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          disabled={!hasDetails}
          className={cn(
            "group inline-flex max-w-full items-center gap-2 rounded-md border border-(--hairline) bg-(--canvas-soft)/70 px-2.5 py-1 text-left transition-colors hover:bg-(--canvas-soft)",
            errorCount > 0 && "border-(--err)/40 bg-(--err)/[0.04]",
          )}
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full animate-pulse",
              errorCount > 0 ? "bg-(--err)" : "bg-(--primary)",
            )}
            aria-hidden
          />
          <span className="truncate text-[11px] font-medium text-(--ink)">{statusLine}</span>
          {errorCount > 0 && (
            <span className="shrink-0 rounded bg-(--err)/12 px-1.5 py-0.5 font-mono text-[10px] font-medium text-(--err) tabular-nums">
              {t("{n} failed", { n: errorCount })}
            </span>
          )}
          {hasDetails &&
            (open ? (
              <ChevronDown size={13} className="shrink-0 text-(--mute)" />
            ) : (
              <ChevronRight size={13} className="shrink-0 text-(--mute)" />
            ))}
        </CollapsibleTrigger>

        {hasDetails && (
          <CollapsibleContent>
            <div className="mt-2 space-y-1.5 border-l-2 border-(--primary)/30 pl-3">
              {thinkingParts.map((chunk, i) => (
                <div
                  key={`live-think-${i}`}
                  className="rounded-md bg-(--canvas-soft)/50 px-2.5 py-1.5 text-xs italic text-(--mute) whitespace-pre-wrap"
                >
                  {chunk}
                </div>
              ))}
              {tools.map((tool) => (
                <LiveToolStep key={tool.callId} tool={tool} />
              ))}
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  );
}
