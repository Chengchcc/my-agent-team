"use client";

import Link from "next/link";
import { type ReactNode, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TocHeading } from "@/features/wiki/reader";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface WikiMarkdownProps {
  markdown: string;
  /** The table of contents of this same markdown: its line numbers give headings their ids. */
  toc?: readonly TocHeading[];
  /** Optional handler to open internal wiki links inside a side sheet instead of navigating away. */
  onWikiNavigate?: (path: string) => void;
  className?: string;
}

type HeadingTag = "h1" | "h2" | "h3" | "h4";

const HEADING_SIZE: Record<HeadingTag, string> = {
  h1: "text-[22px]",
  h2: "text-[22px]",
  h3: "text-[19px]",
  h4: "text-[17px]",
};

const LINK_CLASS =
  "text-(--primary) underline decoration-(--primary)/35 underline-offset-4 hover:text-(--primary-deep)";

/** The id the table of contents gave the heading that starts on this line. */
function headingId(toc: readonly TocHeading[], node: { position?: { start: { line: number } } }) {
  const line = node.position?.start.line;
  const entry = toc.find((heading) => heading.line === line);
  const id = entry?.id;
  return id;
}

function wikiPathFromHref(href: string): string | null {
  if (!href.startsWith("/wiki/page?")) return null;
  try {
    const parsed = new URL(href, "http://wiki.local");
    return parsed.searchParams.get("path");
  } catch {
    return null;
  }
}

/** A link that stays inside the console where it can: a source footnote, a page anchor, a wiki
 *  page. Only a real external address opens a new tab. */
function WikiLink({
  href,
  children,
  onWikiNavigate,
}: {
  href?: string;
  children?: ReactNode;
  onWikiNavigate?: (path: string) => void;
}) {
  if (href === undefined) return <span>{children}</span>;
  if (href.startsWith("#wiki-source-")) {
    return (
      <sup>
        <a href={href} className={cn("text-[11px] leading-none", LINK_CLASS)}>
          {children}
        </a>
      </sup>
    );
  }
  const isExternal = /^[a-z][a-z0-9+.-]*:/i.test(href);
  if (isExternal) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
        {children}
      </a>
    );
  }
  const targetWikiPath = onWikiNavigate ? wikiPathFromHref(href) : null;
  return (
    <Link
      href={href}
      className={LINK_CLASS}
      onClick={
        targetWikiPath !== null && onWikiNavigate
          ? (event) => {
              if (
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey ||
                event.button !== 0
              ) {
                return;
              }
              event.preventDefault();
              onWikiNavigate(targetWikiPath);
            }
          : undefined
      }
    >
      {children}
    </Link>
  );
}

interface HeadingNode {
  position?: { start: { line: number } };
}

/** A page body for people: 16px, generous leading, headings that carry the anchors of the table
 *  of contents. Raw HTML in the markdown is shown as text, never rendered. */
export function WikiMarkdown({ markdown, toc = [], onWikiNavigate, className }: WikiMarkdownProps) {
  const components = useMemo<Components>(() => {
    const heading =
      (tag: HeadingTag) =>
      ({ node, children }: { node?: HeadingNode; children?: ReactNode }) => {
        const Tag = tag;
        const id = node === undefined ? undefined : headingId(toc, node);
        return (
          <Tag
            id={id}
            className={cn(
              "mt-[34px] mb-3.5 scroll-mt-5 font-[550] leading-[1.6] text-(--ink-strong)",
              HEADING_SIZE[tag],
            )}
          >
            {children}
          </Tag>
        );
      };
    return {
      h1: heading("h1"),
      h2: heading("h2"),
      h3: heading("h3"),
      h4: heading("h4"),
      h5: heading("h4"),
      h6: heading("h4"),
      p: ({ children }) => <p className="my-0 mb-[21px] last:mb-0">{children}</p>,
      strong: ({ children }) => (
        <strong className="font-semibold text-(--ink-strong)">{children}</strong>
      ),
      a: ({ href, children }) => (
        <WikiLink href={href} onWikiNavigate={onWikiNavigate}>
          {children}
        </WikiLink>
      ),
      ul: ({ children }) => (
        <ul className="my-0 mb-6 list-disc pl-6 marker:text-(--mute)">{children}</ul>
      ),
      ol: ({ children }) => (
        <ol className="my-0 mb-6 list-decimal pl-6 marker:text-(--mute)">{children}</ol>
      ),
      li: ({ children }) => <li className="my-2 leading-[1.9]">{children}</li>,
      blockquote: ({ children }) => (
        <blockquote className="my-5 border-l-2 border-(--hairline) pl-4 text-(--body) italic">
          {children}
        </blockquote>
      ),
      hr: () => <hr className="my-7 border-t border-(--hairline)" />,
      code: ({ className, children, ...props }) => (
        <code
          className={cn(
            "rounded bg-white/5 px-1 py-0.5 font-mono text-[0.88em] text-(--canvas-text-soft)",
            className,
          )}
          {...props}
        >
          {children}
        </code>
      ),
      pre: ({ children }) => (
        <pre className="my-5 overflow-x-auto rounded-[10px] border border-(--hairline) bg-(--panel2) p-[18px] font-mono text-[13px] leading-[1.8] text-(--canvas-text-soft) [&>code]:rounded-none [&>code]:bg-transparent [&>code]:p-0 [&>code]:font-mono [&>code]:text-[13px]">
          {children}
        </pre>
      ),
      table: ({ children }) => (
        <div className="my-5 overflow-x-auto rounded-[10px] border border-(--hairline)">
          <table className="w-full border-collapse text-sm">{children}</table>
        </div>
      ),
      thead: ({ children }) => <thead className="bg-white/3">{children}</thead>,
      tr: ({ children }) => <tr className="border-b border-(--hairline)">{children}</tr>,
      th: ({ children }) => (
        <th className="px-3 py-2 text-left text-xs font-[550] text-(--mute)">{children}</th>
      ),
      td: ({ children }) => <td className="px-3 py-2 align-top text-(--ink)">{children}</td>,
      img: ({ src, alt }) => (
        // Wiki pages are text: an image is named and linked, never loaded into the page.
        <span className="my-5 block text-xs text-(--mute)">
          [{t("Image")}
          {alt === undefined || alt === "" ? "" : `: ${alt}`}
          {typeof src === "string" && src.startsWith("http") ? (
            <>
              {" · "}
              <a href={src} target="_blank" rel="noreferrer" className={LINK_CLASS}>
                {t("Open")}
              </a>
            </>
          ) : (
            ""
          )}
          ]
        </span>
      ),
    };
  }, [toc, onWikiNavigate]);

  return (
    <div className={cn("min-w-0 text-[16px] leading-[1.9] text-(--ink) wrap-anywhere", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

/** Where a source footnote lands. The markers in the body link here. */
export function SourceAnchor({ index, children }: { index: number; children: ReactNode }) {
  return (
    <div
      id={`wiki-source-${index}`}
      className="scroll-mt-5 border-b border-(--hairline) py-3 text-xs leading-[1.8] last:border-b-0"
    >
      <small className="mr-2 font-mono text-[11px] text-(--primary)">[{index}]</small>
      {children}
    </div>
  );
}
