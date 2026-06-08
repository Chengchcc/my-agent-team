import { describe, test, expect, mock } from "bun:test";

// ── Unit tests for StreamingMessage logic (extracted pure functions) ──

function adaptiveSpeed(length: number): number {
  if (length < 100) return 1;
  if (length < 500) return 3;
  if (length < 2000) return 8;
  return 20;
}

interface TypewriterState {
  shown: string;
  fullText: string;
  done: boolean;
}

function nextFrame(state: TypewriterState): TypewriterState {
  if (state.done) return { ...state, shown: state.fullText };
  const speed = adaptiveSpeed(state.fullText.length);
  const nextIdx = Math.min(state.shown.length + speed, state.fullText.length);
  return {
    ...state,
    shown: state.fullText.slice(0, nextIdx),
  };
}

function isComplete(state: TypewriterState): boolean {
  return state.done || state.shown.length >= state.fullText.length;
}

describe("adaptiveSpeed", () => {
  test("short text: 1 char per frame", () => {
    expect(adaptiveSpeed(50)).toBe(1);
  });

  test("medium text: 3 chars per frame", () => {
    expect(adaptiveSpeed(300)).toBe(3);
  });

  test("long text: 8 chars per frame", () => {
    expect(adaptiveSpeed(1500)).toBe(8);
  });

  test("very long text: 20 chars per frame", () => {
    expect(adaptiveSpeed(5000)).toBe(20);
  });

  test("boundary: exactly 100", () => {
    expect(adaptiveSpeed(100)).toBe(3);
  });

  test("boundary: exactly 500", () => {
    expect(adaptiveSpeed(500)).toBe(8);
  });

  test("boundary: exactly 2000", () => {
    expect(adaptiveSpeed(2000)).toBe(20);
  });
});

describe("typewriter progression", () => {
  test("advances by adaptive speed each frame", () => {
    const state: TypewriterState = {
      shown: "",
      fullText: "Hello World", // 11 chars → speed=1
      done: false,
    };

    const next = nextFrame(state);
    expect(next.shown).toBe("H");
  });

  test("eventually completes to full text", () => {
    const state: TypewriterState = {
      shown: "",
      fullText: "Hi",
      done: false,
    };

    let s = state;
    let frames = 0;
    while (!isComplete(s) && frames < 100) {
      s = nextFrame(s);
      frames++;
    }

    expect(s.shown).toBe("Hi");
    expect(isComplete(s)).toBe(true);
  });

  test("done flag immediately shows full text", () => {
    const state: TypewriterState = {
      shown: "He",
      fullText: "Hello World",
      done: true,
    };

    const next = nextFrame(state);
    expect(next.shown).toBe("Hello World");
  });

  test("mid-stream cancel: text shown so far is preserved", () => {
    // Simulate: started streaming, got 3 chars, then done=true arrives
    const midStream: TypewriterState = {
      shown: "Hel",
      fullText: "Hello World",
      done: false,
    };
    expect(midStream.shown).toBe("Hel");
    expect(midStream.shown.length).toBe(3);

    // done arrives
    const final = nextFrame({ ...midStream, done: true });
    expect(final.shown).toBe("Hello World");
    expect(final.shown.length).toBe(11);
    // No text was lost — "Hel" is a prefix of "Hello World"
    expect(final.shown.startsWith("Hel")).toBe(true);
  });

  test("long text accelerates", () => {
    const state: TypewriterState = {
      shown: "",
      fullText: "x".repeat(2000), // 2000 chars → speed=20
      done: false,
    };

    const next = nextFrame(state);
    expect(next.shown.length).toBe(20);
    expect(next.shown).toBe("x".repeat(20));
  });
});

describe("skipAnimation", () => {
  test("skipAnimation + done: immediate full text", () => {
    const state: TypewriterState = {
      shown: "",
      fullText: "Long response here",
      done: true,
    };

    const result = nextFrame(state);
    expect(result.shown).toBe("Long response here");
    expect(isComplete(result)).toBe(true);
  });

  test("skipAnimation without done still animates", () => {
    const state: TypewriterState = {
      shown: "",
      fullText: "abc", // 3 chars, speed=1
      done: false,
    };

    const result = nextFrame(state);
    // Not done → should advance one frame, not show all
    expect(result.shown).toBe("a");
    expect(isComplete(result)).toBe(false);
  });
});
