import { spawnSync } from "node:child_process";

/**
 * What a comment-triggered run reads (ADR 0044 follow-up, found by the live
 * acceptance): the comment is the REQUEST, the document is the CONTEXT. Handing
 * over only the comment made "summarize this document" impossible without
 * tools — the model improvised, hit a permission approval, and parked in a lane
 * that cannot ask (`ps aux | grep` was its first idea). Passing the text makes
 * the common asks plain-text work again.
 *
 * Two parts, split for the same reason as everywhere else in this app: a pure
 * composer that can be tested, and a thin fetcher whose failure is boring.
 */

/** A document longer than this is clipped rather than crowded in. The comment
 *  is the message; the document rides along so the model has something to read. */
export const DOC_TEXT_LIMIT = 20_000;

/** The run's input text: the comment, then the document when we have it. */
export function composeCommentRunText(input: {
  body: string;
  fileToken: string;
  docText: string | null;
}): string {
  const body = input.body.trim();
  const doc = input.docText?.trim() ?? "";
  if (doc === "") {
    // Say what happened instead of silently dropping the context: a model told
    // nothing will go looking, and looking is what needs approval.
    return `${body}\n\n<document token="${input.fileToken}" note="正文未取到，只有令牌" />`;
  }
  const clipped =
    doc.length > DOC_TEXT_LIMIT
      ? `${doc.slice(0, DOC_TEXT_LIMIT)}\n\n（文档过长，此处已截断）`
      : doc;
  return `${body}\n\n<document token="${input.fileToken}">\n${clipped}\n</document>`;
}

export interface FetchDocTextOptions {
  /** The lark-cli profile this bot runs with (it holds the app credentials). */
  profile: string;
  fileToken: string;
  /** Injection point for tests; defaults to spawning lark-cli. */
  run?: (args: string[]) => { code: number; out: string };
}

/** The document's text, or null. Never throws and never blocks for long: a
 *  document the app cannot read means the run goes ahead with the comment
 *  alone, not that the comment is dropped. */
export async function fetchDocText(options: FetchDocTextOptions): Promise<string | null> {
  const run =
    options.run ??
    ((args: string[]) => {
      const r = spawnSync("lark-cli", args, { encoding: "utf8", timeout: 60_000 });
      return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    });
  let result: { code: number; out: string };
  try {
    result = run([
      "--profile",
      options.profile,
      "docs",
      "+fetch",
      "--doc",
      options.fileToken,
      "--doc-format",
      "markdown",
      "--as",
      "bot",
    ]);
  } catch (err) {
    console.error(
      `[lark-bot] doc fetch failed for ${options.fileToken}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (result.code !== 0) {
    console.error(
      `[lark-bot] doc fetch exit=${result.code} for ${options.fileToken}: ${result.out.slice(0, 200)}`,
    );
    return null;
  }
  const text = result.out.trim();
  return text === "" ? null : text;
}
