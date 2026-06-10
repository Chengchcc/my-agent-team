"use client";

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { ArrowUp, AtSign, Bot, CornerDownLeft } from "lucide-react";
import type { SenderRef } from "@/lib/conversation-reducer";

interface ComposerProps {
  onSend: (message: string, addressedTo: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  roster?: Record<string, SenderRef>;
  autoAgentCount: number;
}

export function Composer({
  onSend,
  disabled,
  placeholder = "Type a message…  Ctrl+Enter to send",
  roster,
  autoAgentCount,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const agentMembers = useMemo(() => {
    if (!roster) return [];
    return Object.values(roster).filter((m) => m.kind === "agent");
  }, [roster]);

  const filteredMentions = useMemo(() => {
    const q = mentionFilter.toLowerCase();
    return agentMembers.filter(
      (m) =>
        (m.displayName ?? m.memberId).toLowerCase().includes(q) ||
        m.memberId.toLowerCase().includes(q),
    );
  }, [agentMembers, mentionFilter]);

  // Reset selection when filter changes
  useEffect(() => { setMentionIndex(0); }, [mentionFilter]);

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "44px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  const resolveAddressedTo = useCallback(
    (text: string): string[] => {
      if (!roster || agentMembers.length === 0) return [];
      if (agentMembers.length === 1) return [agentMembers[0]!.memberId];
      const mentioned = new Set<string>();
      const re = /@(\S+)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        const token = match[1]!;
        for (const m of agentMembers) {
          if (
            m.displayName === token ||
            m.memberId === token ||
            m.memberId.endsWith(token)
          ) {
            mentioned.add(m.memberId);
          }
        }
      }
      return [...mentioned];
    },
    [roster, agentMembers],
  );

  const insertMention = useCallback(
    (member: SenderRef) => {
      const el = textareaRef.current;
      if (!el) return;
      const name = member.displayName ?? member.memberId;
      const before = value.slice(0, el.selectionStart);
      const atPos = before.lastIndexOf("@");
      const after = value.slice(el.selectionEnd);
      const newText =
        atPos >= 0
          ? before.slice(0, atPos) + `@${name} ` + after
          : `@${name} ` + value;
      setValue(newText);
      setShowMentions(false);
      setMentionFilter("");
      setTimeout(() => {
        el.focus();
        const cursor = atPos >= 0 ? atPos + name.length + 2 : name.length + 2;
        el.setSelectionRange(cursor, cursor);
      }, 0);
    },
    [value],
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const text = e.target.value;
      setValue(text);
      autoGrow();
      const el = textareaRef.current;
      if (el) {
        const before = text.slice(0, el.selectionStart);
        const atMatch = before.match(/@(\S*)$/);
        if (atMatch && agentMembers.length > 1) {
          setShowMentions(true);
          setMentionFilter(atMatch[1] ?? "");
        } else {
          setShowMentions(false);
          setMentionFilter("");
        }
      }
    },
    [autoGrow, agentMembers.length],
  );

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    const addressedTo = resolveAddressedTo(trimmed);
    onSend(trimmed, addressedTo);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "44px";
      textareaRef.current.focus();
    }
  }, [value, disabled, onSend, resolveAddressedTo]);

  const navigateMention = useCallback(
    (dir: -1 | 1) => {
      if (!showMentions || filteredMentions.length === 0) return;
      setMentionIndex((prev) => {
        const next = prev + dir;
        if (next < 0) return filteredMentions.length - 1;
        if (next >= filteredMentions.length) return 0;
        return next;
      });
    },
    [showMentions, filteredMentions.length],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showMentions && filteredMentions.length > 0) {
      if (e.key === "Escape") {
        e.preventDefault();
        setShowMentions(false);
        return;
      }
      if (e.key === "ArrowDown") { e.preventDefault(); navigateMention(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); navigateMention(-1); return; }
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        insertMention(filteredMentions[mentionIndex]!);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        if (filteredMentions[mentionIndex]) insertMention(filteredMentions[mentionIndex]!);
        return;
      }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const showMentionButton = agentMembers.length > 1;
  const effectivePlaceholder =
    agentMembers.length === 1
      ? placeholder
      : "@agent to address…  Ctrl+Enter to send";

  return (
    <div className="bg-[var(--canvas)] px-6 py-4">
      <div className="mx-auto flex gap-2 items-end relative" style={{ maxWidth: "72ch" }}>
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={disabled ? "Agent is responding…" : effectivePlaceholder}
            rows={1}
            disabled={disabled}
            className="w-full resize-none bg-[var(--canvas-soft)] border border-[var(--hairline)]
                       rounded-md px-3 py-3 text-sm text-[var(--ink)]
                       placeholder:text-[var(--mute)]
                       focus:outline-none focus:border-[var(--primary)]
                       disabled:opacity-40 disabled:cursor-not-allowed
                       transition-colors duration-200"
            style={{ minHeight: "44px", maxHeight: "200px" }}
          />

          {/* @mention popover */}
          {showMentions && (
            <div
              ref={popoverRef}
              className="absolute bottom-full left-0 mb-1 w-72 bg-[var(--canvas)] border border-[var(--hairline)] rounded-lg shadow-xl z-50 overflow-hidden"
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--hairline)] bg-[var(--canvas-soft)]">
                <span className="text-[10px] tracking-[0.1em] uppercase text-[var(--mute)] font-semibold">
                  Mention an agent
                </span>
                <span className="text-[10px] text-[var(--mute)] flex items-center gap-1">
                  <CornerDownLeft size={10} /> to select
                </span>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {filteredMentions.length === 0 ? (
                  <p className="text-xs text-[var(--mute)] px-3 py-3">No matching agents</p>
                ) : (
                  filteredMentions.map((m, i) => (
                    <button
                      key={m.memberId}
                      type="button"
                      onClick={() => insertMention(m)}
                      onMouseEnter={() => setMentionIndex(i)}
                      className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                        i === mentionIndex
                          ? "bg-[var(--primary)]/10"
                          : "hover:bg-[var(--canvas-soft)]"
                      }`}
                    >
                      <Bot size={15} className="text-[var(--primary)] shrink-0" />
                      <span className="text-sm text-[var(--body)] truncate flex-1">
                        {m.displayName ?? m.memberId}
                      </span>
                      <span className="text-[10px] font-mono text-[var(--mute)] shrink-0">agent</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {showMentionButton && (
          <button
            type="button"
            onClick={() => {
              setShowMentions(!showMentions);
              setMentionFilter("");
              setMentionIndex(0);
            }}
            className="shrink-0 p-2 text-[var(--mute)] hover:text-[var(--body)] transition-colors mb-0.5"
            title="Mention an agent"
          >
            <AtSign size={16} />
          </button>
        )}

        <button
          type="button"
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className="shrink-0 bg-[var(--primary)] text-[var(--on-primary)]
                     rounded-md p-2.5 hover:opacity-90
                     disabled:opacity-30 disabled:cursor-not-allowed
                     transition-opacity duration-200 inline-flex items-center justify-center mb-0.5"
        >
          <ArrowUp size={16} className="shrink-0" aria-label="Send" />
        </button>
      </div>
    </div>
  );
}
