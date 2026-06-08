"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface AgentEvent {
  type: "message" | "interrupted" | "error";
  payload: unknown;
}

export type LiveStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "done"
  | "error";

export function useLiveEvents(runId: string | null) {
  const [messages, setMessages] = useState<
    Array<{ seq: number; event: AgentEvent }>
  >([]);
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const seenRef = useRef<Set<number>>(new Set());

  const reset = useCallback(() => {
    setMessages([]);
    setStatus("idle");
    setError(null);
    seenRef.current = new Set();
  }, []);

  useEffect(() => {
    if (!runId) {
      setStatus("idle");
      return;
    }

    setStatus("connecting");
    const url = `/bff/api/runs/${runId}/events`;
    const es = new EventSource(url);

    const handleEvent = (eventType: string) => (e: MessageEvent) => {
      try {
        const payload: unknown = JSON.parse(e.data);
        const event: AgentEvent = {
          type: eventType as AgentEvent["type"],
          payload,
        };
        const seq = e.lastEventId ? parseInt(e.lastEventId, 10) : 0;
        if (seenRef.current.has(seq)) return;
        seenRef.current.add(seq);
        setMessages((prev) => [...prev, { seq, event }]);
        setStatus("streaming");
      } catch {
        // Skip malformed events
      }
    };

    es.addEventListener("message", handleEvent("message"));
    es.addEventListener("interrupted", handleEvent("interrupted"));
    es.addEventListener("error", handleEvent("error"));

    es.addEventListener("error", () => {
      if (es.readyState === EventSource.CLOSED) {
        setStatus("error");
        setError("Stream connection lost");
      }
    });

    es.addEventListener("done", () => {
      setStatus("done");
      es.close();
    });

    return () => {
      es.close();
    };
  }, [runId]);

  return { messages, status, error, reset };
}
