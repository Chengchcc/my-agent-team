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

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    textareaRef.current?.focus();
  }, [value, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-[var(--border-color)] bg-[var(--cream)] px-6 py-4">
      <div className="flex gap-3 items-end max-w-3xl mx-auto">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={disabled}
          className="flex-1 resize-none bg-transparent border-0 border-b border-[var(--border-color)]
                     px-0 py-3 font-[family-name:var(--font-heading)] text-[15px] text-[var(--charcoal)]
                     placeholder:text-[var(--border-color)]
                     focus:outline-none focus:border-[var(--brass)]
                     disabled:opacity-40 disabled:cursor-not-allowed
                     transition-colors duration-300"
          style={{ minHeight: "44px", maxHeight: "128px" }}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className="shrink-0 border border-[var(--charcoal)] bg-[var(--charcoal)]
                     text-[var(--cream)] px-5 py-3 font-[family-name:var(--font-mono)]
                     text-[10px] tracking-[0.15em] uppercase
                     hover:bg-[var(--brass)] hover:border-[var(--brass)]
                     disabled:opacity-30 disabled:cursor-not-allowed
                     transition-colors duration-300"
        >
          Send
        </button>
      </div>
    </div>
  );
}
