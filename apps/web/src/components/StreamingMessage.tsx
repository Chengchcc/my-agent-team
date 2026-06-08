"use client";

import { useState, useEffect, useRef } from "react";
import { MessageBubble } from "./MessageBubble";

function adaptiveSpeed(length: number): number {
  if (length < 100) return 1;
  if (length < 500) return 3;
  if (length < 2000) return 8;
  return 20;
}

interface StreamingMessageProps {
  fullText: string;
  done: boolean;
  skipAnimation?: boolean;
}

export function StreamingMessage({
  fullText,
  done,
  skipAnimation,
}: StreamingMessageProps) {
  const [shown, setShown] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (done || skipAnimation) {
      setShown(fullText);
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    const speed = adaptiveSpeed(fullText.length);
    timerRef.current = setInterval(() => {
      setShown((prev) => {
        const nextIdx = prev.length + speed;
        if (nextIdx >= fullText.length) {
          if (timerRef.current) clearInterval(timerRef.current);
          return fullText;
        }
        return fullText.slice(0, nextIdx);
      });
    }, 16);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fullText, done, skipAnimation]);

  if (done && shown.length >= fullText.length) {
    return <MessageBubble role="assistant" content={fullText} />;
  }

  return <MessageBubble role="assistant" content={shown} isStreaming />;
}
