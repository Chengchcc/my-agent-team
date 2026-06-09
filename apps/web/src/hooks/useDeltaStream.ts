"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  createStreamAst,
  appendDelta,
  finalizeBlocks,
  type StreamAst,
} from "@/lib/stream-ast";

export type DeltaConnection = "idle" | "connected" | "degraded";

export interface DeltaStreamState {
  ast: StreamAst;
  connection: DeltaConnection;
  finalize: (authoritativeBlocks: Array<{ type: string; text?: string }>) => void;
  /** Tools currently executing (tool_start without matching tool_end). */
  activeTools: string[];
}

export function useDeltaStream(runId: string | null): DeltaStreamState {
  const [ast, setAst] = useState<StreamAst>(createStreamAst);
  const [connection, setConnection] = useState<DeltaConnection>("idle");
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const pendingRef = useRef<Array<{ blockIndex: number; text: string }>>([]);
  const rafRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const connectedRef = useRef(false);
  const activeMapRef = useRef<Map<string, string>>(new Map()); // id → name

  // rAF batch processor — merges pending deltas into one AST update per frame
  const flushPending = useCallback(() => {
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    pendingRef.current = [];
    setAst((prev) => {
      let cur = prev;
      for (const d of pending) {
        cur = appendDelta(cur, d.text);
      }
      return cur;
    });
  }, []);

  useEffect(() => {
    if (!runId) {
      setConnection("idle");
      return;
    }

    setAst(createStreamAst());
    connectedRef.current = false;
    setConnection("idle");
    pendingRef.current = [];
    activeMapRef.current = new Map();
    setActiveTools([]);

    const es = new EventSource(`/api/bff/runs/${runId}/stream`);

    es.onopen = () => {
      connectedRef.current = true;
      setConnection("connected");
    };

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        if (connectedRef.current) {
          connectedRef.current = false;
          setConnection("idle");
          return;
        }
        console.warn(
          "[useDeltaStream] /stream unavailable, falling back to typewriter",
        );
        setConnection("degraded");
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

    es.addEventListener("tool_start", (e: Event) => {
      if (!(e instanceof MessageEvent)) return;
      try {
        const { id, name } = JSON.parse(e.data as string) as {
          id: string;
          name: string;
        };
        if (!id || !name) return;
        activeMapRef.current.set(id, name);
        setActiveTools([...activeMapRef.current.values()]);
      } catch {
        // skip
      }
    });

    es.addEventListener("tool_end", (e: Event) => {
      if (!(e instanceof MessageEvent)) return;
      try {
        const { id } = JSON.parse(e.data as string) as { id: string };
        activeMapRef.current.delete(id);
        setActiveTools([...activeMapRef.current.values()]);
      } catch {
        // skip
      }
    });

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      es.close();
    };
  }, [runId, flushPending]);

  const finalize = useCallback(
    (authoritativeBlocks: Array<{ type: string; text?: string }>) => {
      setAst((prev) => finalizeBlocks(prev, authoritativeBlocks));
    },
    [],
  );

  return { ast, connection, finalize, activeTools };
}
