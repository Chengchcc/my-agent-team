import type { Tool } from "@my-agent-team/core";
import {
  assertSafeUrl,
  FETCH_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
} from "./url-guard.js";

export const webFetchTool: Tool = {
  name: "web_fetch",
  description: "Fetch content from a URL and return as plain text",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch" },
    },
    required: ["url"],
  },
  async execute(input) {
    const { url } = input as { url: string };
    assertSafeUrl(url);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

    try {
      let currentUrl = url;
      for (let redirect = 0; redirect < MAX_REDIRECTS; redirect++) {
        const response = await fetch(currentUrl, {
          signal: ac.signal,
          redirect: "manual",
        });

        // Follow redirects manually with URL validation
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) break;
          assertSafeUrl(location);
          currentUrl = location;
          continue;
        }

        // Stream response up to limit
        const reader = response.body?.getReader();
        if (!reader) return { content: "" };

        let text = "";
        let done = false;
        while (!done) {
          const result = await reader.read();
          if (result.done) {
            done = true;
          } else {
            const chunk = new TextDecoder().decode(result.value);
            text += chunk;
            if (text.length >= MAX_RESPONSE_BYTES) {
              reader.cancel();
              done = true;
            }
          }
        }

        const truncated = text.length >= MAX_RESPONSE_BYTES;
        const display = truncated ? `${text.slice(0, MAX_RESPONSE_BYTES)}\n\n... (truncated)` : text;
        return { content: display };
      }

      return { content: "Too many redirects" };
    } finally {
      clearTimeout(timer);
    }
  },
};
