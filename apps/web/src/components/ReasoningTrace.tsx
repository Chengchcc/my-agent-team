"use client";

import { hasDedicatedEvent } from "@chengchenccc/api-contract";
import { AlertCircle, ChevronDown, ChevronRight, Sparkles, Wrench } from "lucide-react";
import { useState } from "react";
import type { TurnSegment } from "@/lib/conversation-reducer";
import { t } from "@/lib/i18n";
import { collectToolResults } from "@/lib/render-blocks";
import { extractText } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";
import { MessageBubble } from "./MessageBubble";
import { ToolStep } from "./ToolStep";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

interface ThinkingBlock {
  type: "thinking";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

function extractThinking(blocks: readonly unknown[] | undefined): ThinkingBlock[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter(
    (b): b is ThinkingBlock =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: string }).type === "thinking" &&
      typeof (b as { text?: string }).text === "string" &&
      (b as { text: string }).text.trim().length > 0,
  );
}

/** Per-turn reasoning trace (Antigravity conclusion-first anatomy):
 *  - Every user-facing answer (any consecutive standalone reply with no
 *    tool calls plus the final `conclusion`) renders visibly at full width.
 *  - All thinking blocks and tool-calling rounds fold into a single compact
 *    collapsible bar below the reply (default closed).
 *  - Tools with a dedicated surface event (`todo_write`, `ask_question`) stay
 *    outside this generic trace so they are never duplicated or buried. */
export function ReasoningTrace({
  segment,
  defaultOpen = false,
  showSender = false,
  isFirst = true,
  isLast = false,
  senderName,
}: {
  segment: Extract<TurnSegment, { kind: "turn" }>;
  defaultOpen?: boolean;
  showSender?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
  senderName?: string;
}) {
  const [openTrace, setOpenTrace] = useState(defaultOpen);
  const { rounds, conclusion, sender } = segment;

  // Cross-message tool_result aggregation (rounds + conclusion).
  const resultMap = new Map<string, { content: string; isError?: boolean }>();
  for (const m of [...rounds, ...(conclusion ? [conclusion] : [])]) {
    const blocks = m.content.blocks;
    if (Array.isArray(blocks)) collectToolResults(blocks, resultMap);
  }

  const name = senderName ?? sender.displayName ?? sender.memberId;

  const roundEntries = rounds
    .filter((m) => m.content.role !== "tool")
    .map((m) => {
      const blocks = m.content.blocks ?? [];
      const thinking = extractThinking(blocks);
      const tools = blocks.filter(
        (b): b is ToolUseBlock => b.type === "tool_use" && !!b.id && !hasDedicatedEvent(b.name),
      );
      const narrative =
        extractText(m.content) ||
        blocks
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join(" ")
          .trim();
      return { m, thinking, narrative, tools };
    });

  const conclusionText = conclusion
    ? extractText(conclusion.content) ||
      (typeof conclusion.content === "string" ? conclusion.content : "")
    : "";
  const conclusionThinking = conclusion ? extractThinking(conclusion.content.blocks) : [];

  // Visible replies:
  // 1. Any round with no tool calls and non-empty text is a standalone reply
  //    (e.g., an earlier run's conclusion inside a consecutive PA burst) —
  //    never bury real replies inside the thinking/tooling drawer.
  // 2. The final conclusion (if non-empty).
  // 3. Fallback: if both are empty (turn stopped mid-tool-loop), promote the
  //    last non-empty tool-round narrative so the turn never looks blank.
  const visibleReplies: Array<{ id: string; text: string; createdAt?: number }> = [];
  const visibleRoundIds = new Set<string>();

  for (const r of roundEntries) {
    if (r.tools.length === 0 && r.narrative) {
      visibleReplies.push({ id: r.m.id, text: r.narrative, createdAt: r.m.content.createdAt });
      visibleRoundIds.add(r.m.id);
    }
  }
  if (conclusion && conclusionText) {
    visibleReplies.push({
      id: conclusion.id,
      text: conclusionText,
      createdAt: conclusion.content.createdAt,
    });
  }
  if (visibleReplies.length === 0) {
    for (let i = roundEntries.length - 1; i >= 0; i--) {
      const r = roundEntries[i]!;
      if (r.narrative) {
        visibleReplies.push({ id: r.m.id, text: r.narrative, createdAt: r.m.content.createdAt });
        visibleRoundIds.add(r.m.id);
        break;
      }
    }
  }

  // Count steps, thinking fragments, and errors across the whole turn.
  let toolCount = 0;
  let errorCount = 0;
  let thinkingCount = conclusionThinking.length;
  for (const r of roundEntries) {
    thinkingCount += r.thinking.length;
    toolCount += r.tools.length;
    for (const tool of r.tools) {
      if (resultMap.get(tool.id)?.isError) errorCount++;
    }
  }

  const hasTrace = toolCount > 0 || thinkingCount > 0;
  const lastCreatedAt =
    visibleReplies[visibleReplies.length - 1]?.createdAt ??
    conclusion?.content.createdAt ??
    roundEntries[roundEntries.length - 1]?.m.content.createdAt;

  const summaryLabel =
    thinkingCount > 0 && toolCount > 0
      ? t("View thinking & tool steps")
      : toolCount > 0
        ? t("View tool steps")
        : t("View thinking");

  return (
    <div data-slot="reasoning-turn" className="min-w-0 w-full">
      {/* 1. User-facing replies — conclusion first, full width */}
      {visibleReplies.map((reply, idx) => (
        <MessageBubble
          key={reply.id}
          align="left"
          name={name}
          createdAt={reply.createdAt}
          content={reply.text}
          showSender={showSender && idx === 0}
          isFirst={isFirst && idx === 0}
          isLast={isLast && !hasTrace && idx === visibleReplies.length - 1}
        />
      ))}

      {/* 2. Collapsed thinking + tooling drawer below the reply */}
      {hasTrace && (
        <div
          data-slot="reasoning-trace-drawer"
          className={cn(
            "min-w-0 w-full",
            visibleReplies.length > 0 ? "mt-2" : isFirst ? "mt-5" : "mt-1.5",
          )}
        >
          <Collapsible open={openTrace} onOpenChange={setOpenTrace}>
            <CollapsibleTrigger
              className={cn(
                "group inline-flex max-w-full items-center gap-1.5 rounded-md border border-(--hairline)/80 bg-(--canvas-soft)/50 px-2.5 py-1 text-left transition-colors hover:border-(--hairline) hover:bg-(--canvas-soft)",
                errorCount > 0 && "border-(--err)/40 bg-(--err)/[0.04]",
              )}
            >
              {openTrace ? (
                <ChevronDown size={13} className="shrink-0 text-(--mute)" />
              ) : (
                <ChevronRight size={13} className="shrink-0 text-(--mute)" />
              )}
              {errorCount > 0 ? (
                <AlertCircle size={12} className="shrink-0 text-(--err)" />
              ) : toolCount > 0 ? (
                <Wrench size={12} className="shrink-0 text-(--mute)" />
              ) : (
                <Sparkles size={12} className="shrink-0 text-(--accent-violet)/80" />
              )}
              <span className="truncate text-[11px] font-medium text-(--mute) group-hover:text-(--ink)">
                {summaryLabel}
              </span>
              {toolCount > 0 && (
                <span className="shrink-0 font-mono text-[10px] text-(--faint) tabular-nums">
                  · {t("{n} steps", { n: toolCount })}
                </span>
              )}
              {errorCount > 0 && (
                <span
                  data-testid="trace-error-count"
                  className="shrink-0 rounded bg-(--err)/12 px-1.5 py-0.5 font-mono text-[10px] font-medium text-(--err) tabular-nums"
                >
                  {t("{n} failed", { n: errorCount })}
                </span>
              )}
            </CollapsibleTrigger>

            <CollapsibleContent>
              <div className="mt-2 space-y-2 border-l-2 border-(--hairline) pl-3">
                {roundEntries.map(({ m, thinking, narrative, tools }) => {
                  const showNarrativeInTrace = Boolean(narrative && !visibleRoundIds.has(m.id));
                  if (thinking.length === 0 && !showNarrativeInTrace && tools.length === 0) {
                    return null;
                  }
                  return (
                    <div key={m.id} className="min-w-0 w-full space-y-1.5">
                      {thinking.map((b, bi) => (
                        <div
                          key={`${m.id}:think:${bi}`}
                          className="rounded-md bg-(--canvas-soft)/50 px-2.5 py-1.5 text-xs text-(--mute)"
                        >
                          <Markdown text={b.text} tone="muted" />
                        </div>
                      ))}
                      {showNarrativeInTrace && (
                        <div className="px-1 text-xs text-(--body)">
                          <Markdown text={narrative} tone="muted" />
                        </div>
                      )}
                      {tools.length > 0 && (
                        <div className="min-w-0 w-full space-y-1.5">
                          {tools.map((tool) => (
                            <ToolStep
                              key={tool.id}
                              name={tool.name}
                              input={tool.input}
                              result={resultMap.get(tool.id)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {conclusionThinking.map((b, bi) => (
                  <div
                    key={`conclusion:think:${bi}`}
                    className="rounded-md bg-(--canvas-soft)/50 px-2.5 py-1.5 text-xs text-(--mute)"
                  >
                    <Markdown text={b.text} tone="muted" />
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {isLast && lastCreatedAt && (
            <div className="mt-1 font-code-sm text-code-sm text-(--faint) tabular-nums">
              {new Date(lastCreatedAt).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
