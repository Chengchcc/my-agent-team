"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import { ArrowUp, AtSign } from "lucide-react";
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "44px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  // Parse @mentions from message text → addressedTo memberIds
  const resolveAddressedTo = useCallback(
    (text: string): string[] => {
      if (!roster || agentMembers.length === 0) return [];
      // Single agent: always auto-addressed (no @ needed)
      if (agentMembers.length === 1) return [agentMembers[0]!.memberId];
      // Multi-agent: parse @displayName or @memberId from text
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
      // Replace trailing '@' + partial filter with full @name
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

      // Detect @ trigger: show mention popup when user types @ followed by partial text
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showMentions && filteredMentions.length > 0) {
      if (e.key === "Escape") {
        e.preventDefault();
        setShowMentions(false);
        return;
      }
      // Tab or Enter on mention selects first match
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        insertMention(filteredMentions[0]!);
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
      : `@agent to address…  Ctrl+Enter to send`;

  return (
    <div className="bg-[var(--canvas)] px-6 py-4">
      <div className="mx-auto" style={{ maxWidth: "72ch" }}>
        <div className="flex gap-3 items-end relative">
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

            {/* @mention popup */}
            {showMentions && (
              <div className="absolute bottom-full left-0 mb-1 w-64 bg-[var(--canvas)] border border-[var(--hairline)] rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
                {filteredMentions.length === 0 ? (
                  <p className="text-xs text-[var(--mute)] px-3 py-2">
                    No matching agents
                  </p>
                ) : (
                  filteredMentions.map((m) => (
                    <button
                      key={m.memberId}
                      type="button"
                      onClick={() => insertMention(m)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-[var(--canvas-soft)] transition-colors"
                    >
                      <span className="text-[var(--primary)] font-medium">
                        @{m.displayName ?? m.memberId}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {showMentionButton && (
            <button
              type="button"
              onClick={() => {
                setShowMentions(!showMentions);
                setMentionFilter("");
              }}
              className="shrink-0 p-2 text-[var(--mute)] hover:text-[var(--body)] transition-colors"
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
                       rounded-md p-2.5
                       hover:opacity-90
                       disabled:opacity-30 disabled:cursor-not-allowed
                       transition-opacity duration-200 inline-flex items-center justify-center"
          >
            <ArrowUp size={16} className="shrink-0" aria-label="Send" />
          </button>
        </div>
      </div>
    </div>
  );
}
