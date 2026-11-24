"use client";

import { loader } from "@monaco-editor/react";

// Monaco is self-hosted: predev.sh copies node_modules/monaco-editor/min/vs
// to apps/web/public/monaco/vs (gitignored, regenerated per machine). The
// old jsdelivr CDN path made Source/code views hang forever on networks
// where the CDN is unreachable.
// An ABSOLUTE base, not "/monaco/vs": inside a worker Monaco resolves nested
// scripts with `new URL(...)` and a root-relative path has no base to resolve
// against, so the JSON language worker died with "Failed to parse URL from
// /monaco/vs/language/json/jsonWorker.js" in both production and dev (audit
// 2026-11-24). The path is the same; only the base is made explicit.
const vs =
  typeof window === "undefined" ? "/monaco/vs" : new URL("/monaco/vs", window.location.origin).href;

loader.config({
  paths: { vs },
  "vs/nls": { availableLanguages: { "*": "" } },
});

export { loader };
