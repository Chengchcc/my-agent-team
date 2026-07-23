"use client";

import { Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

interface SearchResult {
  conversationId: string;
  conversationTitle: string | null;
  seq: number;
  snippet: string;
  senderName: string;
  ts: number;
}

interface GlobalSearchProps {
  open: boolean;
  onClose: () => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function GlobalSearch({ open, onClose }: GlobalSearchProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setActiveIndex(-1);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setActiveIndex(-1);
      return;
    }
    setIsLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await api.searchConversations(query.trim());
        const items = data.results ?? [];
        setResults(Array.isArray(items) ? items : []);
        setActiveIndex(items.length > 0 ? 0 : -1);
      } catch {
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          onClose();
          break;
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((prev) => (prev < results.length - 1 ? prev + 1 : 0));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((prev) => (prev > 0 ? prev - 1 : results.length - 1));
          break;
        case "Enter":
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < results.length) {
            const r = results[activeIndex]!;
            onClose();
            router.push(`/chat/${r.conversationId}`);
          }
          break;
      }
    },
    [results, activeIndex, onClose, router],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Search conversations"
    >
      <div className="w-full max-w-xl rounded-lg border border-[var(--hairline)] bg-[var(--canvas)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center border-b border-[var(--hairline)] px-4 py-0">
          <Search className="mr-3 h-5 w-5 shrink-0 text-[var(--mute)]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search conversations..."
            className="flex-1 bg-transparent py-3 text-base outline-none placeholder:text-[var(--mute)]"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={onClose}
            className="ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--mute)] hover:text-[var(--ink)] hover:bg-[var(--canvas-soft)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto">
          {isLoading && (
            <div className="flex items-center justify-center py-12 text-sm text-[var(--mute)]">
              Searching...
            </div>
          )}

          {!isLoading && query.trim() === "" && (
            <div className="flex flex-col items-center py-12 text-[var(--mute)]">
              <Search className="mb-3 h-8 w-8 opacity-30" />
              <p className="text-sm">Type to search across all conversations</p>
            </div>
          )}

          {!isLoading && query.trim() !== "" && results.length === 0 && (
            <div className="py-12 text-center text-sm text-[var(--mute)]">No results found.</div>
          )}

          {!isLoading &&
            results.map((r, i) => (
              <button
                key={`${r.conversationId}-${r.seq}`}
                type="button"
                onClick={() => {
                  onClose();
                  router.push(`/chat/${r.conversationId}`);
                }}
                onMouseEnter={() => setActiveIndex(i)}
                className={`flex w-full flex-col gap-1 border-b border-[var(--hairline)] px-4 py-3 text-left transition-colors last:border-b-0 ${i === activeIndex ? "bg-[var(--canvas-soft)]" : "hover:bg-[var(--canvas-soft)]"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-[var(--ink-strong)] truncate max-w-[200px]">
                    {r.conversationTitle ?? r.conversationId.slice(0, 8)}
                  </span>
                  <span className="text-xs text-[var(--mute)]">· {r.senderName}</span>
                  <span className="ml-auto text-xs text-[var(--mute)]">{formatTime(r.ts)}</span>
                </div>
                <p className="line-clamp-2 text-sm text-[var(--ink-strong)]">{r.snippet}</p>
              </button>
            ))}
        </div>

        {!isLoading && results.length > 0 && (
          <div className="border-t border-[var(--hairline)] px-4 py-2">
            <p className="text-xs text-[var(--mute)]">{results.length} results</p>
          </div>
        )}
      </div>
    </div>
  );
}
