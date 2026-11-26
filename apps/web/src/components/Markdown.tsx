"use client";

import Link from "next/link";
import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { remarkArtifactUrls } from "@/lib/remark-artifact-url";
import { ArtifactMarkdownCard } from "./ArtifactMarkdownCard";
import { RequirementMarkdownChip } from "./RequirementMarkdownChip";

const REQUIREMENT_HREF_RE = /^\/requirements\/([^/?#]+)$/;

interface MarkdownProps {
  text: string;
  /** "muted" renders a lighter, tighter, whitespace-preserving set for
   *  secondary surfaces (e.g. the thinking trace) that must not compete with
   *  the narrative body for visual weight. */
  tone?: "default" | "muted";
}

function buildComponents(tone: "default" | "muted"): Components {
  const muted = tone === "muted";
  return {
    p: ({ children }) =>
      muted ? (
        <p className="wrap-break-word my-1 first:mt-0 last:mb-0 text-sm/relaxed text-(--mute)">
          {children}
        </p>
      ) : (
        <p className="whitespace-pre-wrap wrap-break-word text-(--ink) text-sm/relaxed my-2 first:mt-0 last:mb-0">
          {children}
        </p>
      ),
    strong: ({ children }) => (
      <strong className={`font-semibold ${muted ? "text-(--body)" : "text-(--ink-strong)"}`}>
        {children}
      </strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => <del className="text-(--mute) line-through">{children}</del>,
    a: ({ href, children }) => {
      if (href?.startsWith("artifacts://")) {
        return <ArtifactMarkdownCard url={href} />;
      }
      if (href) {
        const reqMatch = REQUIREMENT_HREF_RE.exec(href);
        if (reqMatch?.[1]) {
          return (
            <RequirementMarkdownChip
              requirementId={decodeURIComponent(reqMatch[1])}
              fallback={children}
            />
          );
        }
        if (href.startsWith("/") && !href.startsWith("//")) {
          return (
            <Link
              href={href}
              className="text-(--primary-deep) underline underline-offset-2 hover:text-(--primary)"
            >
              {children}
            </Link>
          );
        }
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-(--primary-deep) underline underline-offset-2 hover:text-(--primary)"
        >
          {children}
        </a>
      );
    },

    h1: ({ children }) => (
      <h1 className="font-sans text-xl font-semibold text-(--ink-strong) mt-4 mb-2 first:mt-0">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="font-sans text-lg font-semibold text-(--ink-strong) mt-4 mb-2 first:mt-0">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="font-sans text-base font-semibold text-(--ink-strong) mt-3 mb-1.5 first:mt-0">
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="font-sans text-sm font-semibold text-(--ink-strong) mt-3 mb-1.5 first:mt-0">
        {children}
      </h4>
    ),

    ul: ({ children }) => (
      <ul
        className={
          muted
            ? "list-disc pl-5 my-1 space-y-0.5 text-sm text-(--mute) marker:text-(--faint)"
            : "list-disc pl-5 my-2 space-y-1 text-sm text-(--ink) marker:text-(--mute)"
        }
      >
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol
        className={
          muted
            ? "list-decimal pl-5 my-1 space-y-0.5 text-sm text-(--mute) marker:text-(--faint)"
            : "list-decimal pl-5 my-2 space-y-1 text-sm text-(--ink) marker:text-(--mute)"
        }
      >
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,

    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-(--hairline) pl-3 my-2 text-(--body) italic">
        {children}
      </blockquote>
    ),

    hr: () => <hr className="border-(--hairline) my-3" />,

    code: ({ className, children, ...props }) => {
      const rawText = typeof children === "string" ? children : "";
      const isBlock = /language-/.test(className ?? "") || rawText.includes("\n");
      if (!isBlock) {
        const trimmed = rawText.trim();
        if (/^artifacts:\/\/\S+$/.test(trimmed)) {
          return <ArtifactMarkdownCard url={trimmed} />;
        }
        const reqMatch = REQUIREMENT_HREF_RE.exec(trimmed);
        if (reqMatch?.[1]) {
          return <RequirementMarkdownChip requirementId={decodeURIComponent(reqMatch[1])} />;
        }
        return (
          <code
            className="font-mono text-[0.85em] bg-(--canvas-soft) border border-(--hairline) rounded px-1 py-0.5 text-(--canvas-text-soft)"
            {...props}
          >
            {children}
          </code>
        );
      }
      return (
        <code className={`block font-mono text-[13px] ${className ?? ""}`} {...props}>
          {children}
        </code>
      );
    },
    pre: ({ children }) => (
      <pre className="my-2 overflow-x-auto rounded-lg border border-(--hairline) bg-(--canvas-soft) p-4 font-mono text-[13px] leading-relaxed text-(--canvas-text-soft) [&_code]:rounded-none [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[13px]">
        {children}
      </pre>
    ),

    table: ({ children }) => (
      <div className="overflow-x-auto my-2">
        <table className="w-full border-collapse text-[13px]">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead>{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr>{children}</tr>,
    th: ({ children }) => (
      <th className="px-2 py-1 text-left border-b border-(--hairline) font-semibold text-(--mute) text-[10px] tracking-kicker uppercase">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="px-2 py-1 text-left text-(--ink) border-b border-(--hairline)/60">
        {children}
      </td>
    ),
  };
}

export const Markdown = memo(function Markdown({ text, tone = "default" }: MarkdownProps) {
  const components = useMemo(() => buildComponents(tone), [tone]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkArtifactUrls]}
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
});
