"use client";

import { useState, useRef, useCallback } from "react";

interface ComposerProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function Composer({
  onSend,
  disabled,
  placeholder = "Type a message...",
}: ComposerProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "44px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "44px";
      textareaRef.current.focus();
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === "Enter" && !e.shiftKey) || (e.key === "Enter" && e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="bg-[var(--canvas)] px-6 py-4">
      <div className="flex gap-3 items-end mx-auto" style={{ maxWidth: "72ch" }}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            autoGrow();
          }}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? "Agent is responding…" : placeholder}
          rows={1}
          disabled={disabled}
          className="flex-1 resize-none bg-[var(--canvas-soft)] border border-[var(--hairline)]
                     rounded-md px-3 py-3 text-sm text-[var(--ink)]
                     placeholder:text-[var(--mute)]
                     focus:outline-none focus:border-[var(--primary)]
                     disabled:opacity-40 disabled:cursor-not-allowed
                     transition-colors duration-200"
          style={{ minHeight: "44px", maxHeight: "200px" }}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className="shrink-0 bg-[var(--primary)] text-[var(--on-primary)]
                     rounded-md px-5 py-3 text-sm font-semibold
                     hover:opacity-90
                     disabled:opacity-30 disabled:cursor-not-allowed
                     transition-opacity duration-200"
        >
          Send
        </button>
      </div>
    </div>
  );
}
