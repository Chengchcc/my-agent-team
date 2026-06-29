"use client";

import { memo, useId, useMemo, useTransition, useEffect, useState } from "react";
import { Lexer } from "marked";
import remend from "remend";
import { Markdown } from "./Markdown";

// ── Block parser (adapted from Vercel streamdown) ────────────

const CODE_FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const OPEN_TAG_RE = /<(\w+)[\s>]/;
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function countDoubleDollars(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] === "$" && s[i + 1] === "$") { n++; i++; }
  }
  return n;
}

/**
 * Tokenize markdown into blocks using marked's Lexer.
 * Merges: unclosed HTML tags, unclosed $$ math blocks.
 * If footnotes detected, returns single block.
 */
function parseMarkdownIntoBlocks(markdown: string): string[] {
  if (!markdown) return [];
  // Footnotes — single block to avoid splitting ref/def across mdast trees
  if (/\[\^[\w-]{1,200}\](?!:)/.test(markdown) || /\[\^[\w-]{1,200}\]:/.test(markdown)) {
    return [markdown];
  }

  const tokens = Lexer.lex(markdown, { gfm: true });
  const merged: string[] = [];
  const htmlStack: string[] = [];
  let prevWasCode = false;

  for (const token of tokens) {
    const raw = token.raw;

    // Inside unclosed HTML block — merge with previous
    if (htmlStack.length > 0) {
      const prev = merged[merged.length - 1]!;
      merged[merged.length - 1] = prev + raw;

      const tag = htmlStack[htmlStack.length - 1]!;
      const openRe = new RegExp(`<${tag}(?=[\\s>/])[^>]*>`, "gi");
      const closeRe = new RegExp(`</${tag}(?=[\\s>])[^>]*>`, "gi");
      const opens = (raw.match(openRe) || []).filter((m) => !m.trimEnd().endsWith("/>"));
      const closes = (raw.match(closeRe) || []);
      for (let i = 0; i < opens.length; i++) htmlStack.push(tag);
      for (let i = 0; i < closes.length; i++) {
        if (htmlStack[htmlStack.length - 1] === tag) htmlStack.pop();
      }
      continue;
    }

    // Detect unclosed HTML block start
    if (token.type === "html" && (token as { block?: boolean }).block) {
      const m = raw.match(OPEN_TAG_RE);
      if (m) {
        const tag = m[1]!.toLowerCase();
        if (!VOID_ELEMENTS.has(tag)) {
          const openRe = new RegExp(`<${tag}(?=[\\s>/])[^>]*>`, "gi");
          const closeRe = new RegExp(`</${tag}(?=[\\s>])[^>]*>`, "gi");
          const opens = (raw.match(openRe) || []).filter((r) => !r.trimEnd().endsWith("/>"));
          const closes = (raw.match(closeRe) || []);
          if (opens.length > closes.length) htmlStack.push(tag);
        }
      }
    }

    // Merge unclosed $$ math blocks
    if (merged.length > 0 && !prevWasCode && countDoubleDollars(merged[merged.length - 1]!) % 2 === 1) {
      merged[merged.length - 1] += raw;
      prevWasCode = token.type === "code";
      continue;
    }

    merged.push(raw);
    if (token.type !== "space") prevWasCode = token.type === "code";
  }

  return merged;
}

// ── Incomplete code fence check ──────────────────────────────

function hasIncompleteCodeFence(markdown: string): boolean {
  const lines = markdown.split("\n");
  let openChar: string | null = null;
  let openLen = 0;
  for (const line of lines) {
    const m = CODE_FENCE_RE.exec(line);
    if (openChar === null) {
      if (m) { const run = m[1]!; openChar = run[0]!; openLen = run.length; }
    } else if (m) {
      const run = m[1]!;
      if (run[0] === openChar && run.length >= openLen) { openChar = null; openLen = 0; }
    }
  }
  return openChar !== null;
}

// ── Memoized block ──────────────────────────────────────────

const Block = memo(function Block({ content }: { content: string }) {
  return <Markdown text={content} />;
});

// ── StreamingMarkdown ───────────────────────────────────────

interface StreamingMarkdownProps {
  text: string;
  streaming: boolean;
}

export function StreamingMarkdown({ text, streaming }: StreamingMarkdownProps) {
  const id = useId();
  const [_isPending, startTransition] = useTransition();

  const processed = useMemo(
    () => (streaming ? remend(text) : text),
    [text, streaming],
  );

  const blocks = useMemo(
    () => (streaming ? parseMarkdownIntoBlocks(processed) : [processed]),
    [processed, streaming],
  );

  const [displayed, setDisplayed] = useState<string[]>(blocks);

  useEffect(() => {
    if (streaming) {
      startTransition(() => setDisplayed(blocks));
    } else {
      setDisplayed(blocks);
    }
  }, [blocks, streaming]);

  const lastIdx = displayed.length - 1;

  return (
    <>
      {displayed.map((block, i) => (
        <Block key={`${id}-${i}`} content={block} />
      ))}
    </>
  );
}
