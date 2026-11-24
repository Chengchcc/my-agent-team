"use client";

import { useEffect } from "react";

/** The root layout's own boundary: when the shell itself fails there is no
 *  sidebar or top bar left to render into, so this one brings its own
 *  html/body. Kept dependency-free on purpose — the component library may be
 *  part of what broke. */
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error("[web] root error", error);
  }, [error]);
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0b0d10",
          color: "#c4cdd8",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 480, padding: 24 }}>
          <p style={{ fontSize: 14 }}>The console hit an error.</p>
          <p style={{ fontSize: 11, opacity: 0.7, marginTop: 8, wordBreak: "break-all" }}>
            {error.message || "Unknown error"}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16 }}>
            <button
              type="button"
              onClick={reset}
              style={{
                background: "#18c8de",
                color: "#062026",
                border: 0,
                borderRadius: 6,
                padding: "6px 12px",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                background: "transparent",
                color: "#c4cdd8",
                border: "1px solid #2e3742",
                borderRadius: 6,
                padding: "6px 12px",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
