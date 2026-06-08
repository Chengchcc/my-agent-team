"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  createStreamAst,
  appendDelta,
  finalizeBlock,
  type StreamAst,
} from "@/lib/stream-ast";

export interface DeltaStreamState {
  ast: StreamAst;
  /** Whether /stream is connected and receiving data. */
  connected: boolean;
  /** Whether /stream is unavailable (degraded to typewriter fallback). */
  degraded: boolean;
  /** Call when /events delivers a complete message to align the AST. */
  finalize: (blockIndex: number, authoritativeText: string) => void;
}

export function useDeltaStream(runId: string | null): DeltaStreamState {
  const [ast, setAst] = useState<StreamAst>(createStreamAst);
  const [connected, setConnected] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const pendingRef = useRef<Array<{ blockIndex: number; text: string }>>([]);
  const rafRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const astRef = useRef<StreamAst>(ast);
  astRef.current = ast;

  // rAF batch processor — merges pending deltas into one AST update per frame
  const flushPending = useCallback(() => {
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    pendingRef.current = [];
    setAst((prev) => {
      const next = prev;
      for (const d of pending) {
        appendDelta(next, d.blockIndex, d.text);
      }
      return { ...next, blocks: [...next.blocks] };
    });
  }, []);

  useEffect(() => {
    if (!runId) {
      setConnected(false);
      return;
    }

    // Reset state for new run
    const freshAst = createStreamAst();
    setAst(freshAst);
    astRef.current = freshAst;
    setConnected(false);
    setDegraded(false);
    pendingRef.current = [];

    const url = `/api/bff/runs/${runId}/stream`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setDegraded(false);
    };

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setConnected(false);
        // If we never connected, degrade to typewriter fallback
        if (!connected) {
          console.warn(
            "[useDeltaStream] /stream unavailable, falling back to typewriter",
          );
          setDegraded(true);
        }
      }
    };

    es.addEventListener("text_delta", (e: Event) => {
      if (!(e instanceof MessageEvent)) return;
      try {
        const payload: unknown = JSON.parse(e.data as string);
        const { blockIndex, text } = payload as {
          blockIndex: number;
          text: string;
        };
        if (typeof text !== "string" || typeof blockIndex !== "number") return;

        pendingRef.current.push({ blockIndex, text });

        // rAF throttle — only one flush per animation frame
        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            flushPending();
          });
        }
      } catch {
        // skip malformed delta
      }
    });

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      es.close();
      esRef.current = null;
    };
  }, [runId, flushPending]);

  const finalize = useCallback(
    (blockIndex: number, authoritativeText: string) => {
      setAst((prev) => {
        const patches = finalizeBlock(prev, blockIndex, authoritativeText);
        if (patches.length === 0) return prev;
        return { ...prev, blocks: [...prev.blocks] };
      });
    },
    [],
  );

  return { ast, connected, degraded, finalize };
}
