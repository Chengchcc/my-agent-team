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
    Array<{ seq: number | null; event: AgentEvent }>
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

    // New run → clear previous run's messages
    setMessages([]);
    setError(null);
    seenRef.current = new Set();
    setStatus("connecting");
    const url = `/api/bff/runs/${runId}/events`;
    const es = new EventSource(url);

    es.onopen = () => {
      console.log("[useLiveEvents] EventSource connected");
    };

    es.onerror = (e: Event) => {
      // Only log connection-level errors (not SSE data errors which are MessageEvents)
      if (!(e instanceof MessageEvent)) {
        console.error("[useLiveEvents] EventSource connection error, readyState:", es.readyState);
      }
      if (es.readyState === EventSource.CLOSED) {
        setStatus("error");
        setError("Stream connection lost");
      }
    };

    const handleSSEEvent = (eventType: string) => (e: Event) => {
      if (!(e instanceof MessageEvent)) return;
      try {
        const payload: unknown = JSON.parse(e.data as string);
        console.log("[useLiveEvents] event:", eventType, "seq:", e.lastEventId);
        const event: AgentEvent = {
          type: eventType as AgentEvent["type"],
          payload,
        };
        const seq = e.lastEventId ? parseInt(e.lastEventId, 10) : null;
        if (seq !== null && seenRef.current.has(seq)) return;
        if (seq !== null) seenRef.current.add(seq);
        // Events without an id (non-durable, or from legacy backends)
        // are never deduplicated.
        setMessages((prev) => [...prev, { seq, event }]);
        setStatus("streaming");
      } catch {
        // Skip malformed events
      }
    };

    es.addEventListener("message", handleSSEEvent("message"));
    es.addEventListener("interrupted", handleSSEEvent("interrupted"));
    es.addEventListener("error", handleSSEEvent("error"));

    es.addEventListener("done", () => {
      console.log("[useLiveEvents] received done, closing");
      setStatus("done");
      es.close();
    });

    return () => {
      console.log("[useLiveEvents] cleanup, closing EventSource");
      es.close();
    };
  }, [runId]);

  return { messages, status, error, reset };
}
