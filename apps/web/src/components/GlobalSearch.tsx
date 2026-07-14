"use client";

import { Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

interface GlobalSearchProps {
  open: boolean;
  onClose: () => void;
}

interface SearchResult {
  conversationId: string;
  seq: number;
  snippet: string;
  ts: number;
}

function highlightMatch(text: string, query: string): string {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(
    new RegExp(`(${escaped})`, "gi"),
    '<mark class="bg-yellow-200 px-0.5 rounded">$1</mark>',
  );
}

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
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
      return;
    }
    setIsLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await api.searchConversations(query.trim());
        const items = data.results ?? [];
        setResults(items);
        setActiveIndex(items.length > 0 ? 0 : -1);
      } catch {
        setResults([]);
        setActiveIndex(-1);
      } finally {
        setIsLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const navigateToResult = useCallback(
    (result: SearchResult) => {
      onClose();
      router.push(`/chat/${result.conversationId}`);
    },
    [router, onClose],
  );

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
            navigateToResult(results[activeIndex]!);
          }
          break;
      }
    },
    [results, activeIndex, onClose, navigateToResult],
  );

  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, []);

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
      <div
        className="w-full max-w-xl rounded-lg border border-[var(--hairline)] bg-[var(--canvas)] shadow-xl overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--hairline)]">
          <Search size={16} className="text-[var(--mute)] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            className="flex-1 bg-transparent text-sm text-[var(--ink-strong)] placeholder:text-[var(--mute)] focus:outline-none"
          />
          {isLoading && <span className="text-xs text-[var(--mute)]">searching…</span>}
          <button
            onClick={onClose}
            className="text-[var(--mute)] hover:text-[var(--ink-strong)] shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        {results.length > 0 ? (
          <div className="max-h-[50vh] overflow-y-auto">
            {results.map((r, i) => (
              <button
                key={`${r.conversationId}-${r.seq}`}
                ref={i === activeIndex ? activeItemRef : undefined}
                onClick={() => navigateToResult(r)}
                className={`w-full text-left px-4 py-3 border-b border-[var(--hairline)] last:border-0 transition-colors ${
                  i === activeIndex ? "bg-[var(--canvas-soft)]" : "hover:bg-[var(--canvas-soft)]"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-mono text-[var(--mute)]">
                    {r.conversationId.slice(0, 12)}…
                  </span>
                  <span className="text-[10px] text-[var(--mute)]">{formatTime(r.ts)}</span>
                </div>
                <p
                  className="text-sm text-[var(--ink-strong)] line-clamp-2"
                  dangerouslySetInnerHTML={{
                    __html: highlightMatch(r.snippet, query),
                  }}
                />
              </button>
            ))}
          </div>
        ) : query.trim() && !isLoading ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-[var(--mute)]">No results found</p>
          </div>
        ) : null}

        <div className="px-4 py-2 border-t border-[var(--hairline)] flex items-center justify-between text-[10px] text-[var(--mute)]">
          <span>↑↓ to navigate · Enter to open · Esc to close</span>
        </div>
      </div>
    </div>
  );
}
