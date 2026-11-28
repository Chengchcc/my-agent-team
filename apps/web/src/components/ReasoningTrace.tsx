"use client";

import { hasDedicatedEvent } from "@chengchenccc/api-contract";
import { AlertCircle, ChevronDown, ChevronRight, Sparkles } from "lucide-react";
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

/** Codex / Antigravity semantic summary of tool calls in a turn:
 *  groups reads/searches, edits/writes, commands, web lookups, and other calls
 *  into a concise human-readable line (e.g. "Explored 3 files · ran 1 command"). */
export function summarizeToolSteps(toolNames: readonly string[]): string {
  if (toolNames.length === 0) return "";
  let reads = 0;
  let edits = 0;
  let cmds = 0;
  let web = 0;
  let other = 0;
  for (const raw of toolNames) {
    const n = raw.toLowerCase();
    if (
      n.includes("read") ||
      n.includes("grep") ||
      n.includes("glob") ||
      n.includes("search") ||
      n.includes("list") ||
      n.includes("ls") ||
      n.includes("tree") ||
      n.includes("query") ||
      n.includes("history_")
    ) {
      reads++;
    } else if (
      n.includes("edit") ||
      n.includes("write") ||
      n.includes("patch") ||
      n.includes("save")
    ) {
      edits++;
    } else if (
      n.includes("bash") ||
      n.includes("exec") ||
      n.includes("eval") ||
      n.includes("shell") ||
      n.includes("run")
    ) {
      cmds++;
    } else if (
      n.includes("web") ||
      n.includes("fetch") ||
      n.includes("http") ||
      n.includes("browser")
    ) {
      web++;
    } else {
      other++;
    }
  }
  const parts: string[] = [];
  if (reads > 0)
    parts.push(reads === 1 ? t("Explored 1 item") : t("Explored {n} items", { n: reads }));
  if (edits > 0) parts.push(edits === 1 ? t("edited 1 file") : t("edited {n} files", { n: edits }));
  if (cmds > 0) parts.push(cmds === 1 ? t("ran 1 command") : t("ran {n} commands", { n: cmds }));
  if (web > 0)
    parts.push(web === 1 ? t("checked 1 web source") : t("checked {n} web sources", { n: web }));
  if (other > 0) {
    parts.push(
      parts.length === 0
        ? other === 1
          ? t("Ran 1 tool")
          : t("Ran {n} tools", { n: other })
        : other === 1
          ? t("1 other step")
          : t("{n} other steps", { n: other }),
    );
  }
  const joined = parts.join(", ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** Per-turn reasoning trace (Codex / Antigravity chronological anatomy):
 *  - Whisper-quiet collapsible thinking + tool summary sits ABOVE the answer
 *    (matching natural execution flow with zero layout jump after streaming).
 *  - Every user-facing answer (standalone replies + final conclusion) renders
 *    visibly at full width in clean editorial Markdown.
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

  const allToolNames: string[] = [];
  let errorCount = 0;
  let thinkingCount = conclusionThinking.length;
  for (const r of roundEntries) {
    thinkingCount += r.thinking.length;
    for (const tool of r.tools) {
      allToolNames.push(tool.name);
      if (resultMap.get(tool.id)?.isError) errorCount++;
    }
  }
  const toolCount = allToolNames.length;
  const hasTrace = toolCount > 0 || thinkingCount > 0;
  const lastCreatedAt =
    visibleReplies[visibleReplies.length - 1]?.createdAt ??
    conclusion?.content.createdAt ??
    roundEntries[roundEntries.length - 1]?.m.content.createdAt;

  const semanticTools = summarizeToolSteps(allToolNames);
  const summaryLabel = toolCount > 0 ? semanticTools : t("Thought process");

  return (
    <div data-slot="reasoning-turn" className="min-w-0 w-full">
      {/* Optional multi-agent sender label sits once at top of the turn */}
      {showSender && name && hasTrace && (
        <div className={cn("text-[11px] font-medium text-(--primary)", isFirst ? "mt-5" : "mt-2")}>
          {name}
        </div>
      )}

      {/* 1. Whisper-quiet collapsible thought & work trace ABOVE the reply */}
      {hasTrace && (
        <div
          data-slot="reasoning-trace-drawer"
          className={cn(
            "min-w-0 w-full",
            showSender && name ? "mt-1" : isFirst ? "mt-4" : "mt-2",
            visibleReplies.length > 0 && "mb-2",
          )}
        >
          <Collapsible open={openTrace} onOpenChange={setOpenTrace}>
            <CollapsibleTrigger
              className={cn(
                "group inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-(--panel)",
                errorCount > 0 && "text-(--err)",
              )}
            >
              {openTrace ? (
                <ChevronDown
                  size={13}
                  className="shrink-0 text-(--faint) group-hover:text-(--mute)"
                />
              ) : (
                <ChevronRight
                  size={13}
                  className="shrink-0 text-(--faint) group-hover:text-(--mute)"
                />
              )}
              {errorCount > 0 ? (
                <AlertCircle size={12} className="shrink-0 text-(--err)" />
              ) : thinkingCount > 0 && toolCount === 0 ? (
                <Sparkles size={12} className="shrink-0 text-(--accent-violet)/80" />
              ) : null}
              <span className="truncate text-[12px] font-medium text-(--mute) group-hover:text-(--ink)">
                {summaryLabel}
              </span>
              {toolCount > 0 && (
                <span className="shrink-0 font-mono text-[10px] text-(--faint) tabular-nums">
                  · {toolCount === 1 ? t("1 step") : t("{n} steps", { n: toolCount })}
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
              <div className="mt-1.5 ml-1.5 space-y-1.5 border-l border-(--hairline) pl-3 pb-1">
                {roundEntries.map(({ m, thinking, narrative, tools }) => {
                  const showNarrativeInTrace = Boolean(narrative && !visibleRoundIds.has(m.id));
                  if (thinking.length === 0 && !showNarrativeInTrace && tools.length === 0) {
                    return null;
                  }
                  return (
                    <div key={m.id} className="min-w-0 w-full space-y-1">
                      {thinking.map((b, bi) => (
                        <div
                          key={`${m.id}:think:${bi}`}
                          className="rounded-md bg-(--panel)/50 px-2.5 py-1.5 text-xs text-(--mute)"
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
                        <div className="min-w-0 w-full space-y-0.5">
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
                    className="rounded-md bg-(--panel)/50 px-2.5 py-1.5 text-xs text-(--mute)"
                  >
                    <Markdown text={b.text} tone="muted" />
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}

      {/* 2. User-facing replies — clean full-width editorial Markdown */}
      {visibleReplies.map((reply, idx) => (
        <MessageBubble
          key={reply.id}
          align="left"
          name={name}
          createdAt={reply.createdAt}
          content={reply.text}
          showSender={showSender && !hasTrace && idx === 0}
          isFirst={isFirst && !hasTrace && idx === 0}
          isLast={isLast && idx === visibleReplies.length - 1}
        />
      ))}

      {/* Timestamp when a turn has trace only and no visible reply */}
      {visibleReplies.length === 0 && isLast && lastCreatedAt && (
        <div className="mt-1 font-code-sm text-code-sm text-(--faint) tabular-nums">
          {new Date(lastCreatedAt).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </div>
      )}
    </div>
  );
}
