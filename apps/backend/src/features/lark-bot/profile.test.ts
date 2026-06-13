import { describe, expect, test } from "bun:test";

// The sanitize function is private — test the behavior via the exported function's
// error message format. For unit testing, verify the pattern directly.
function sanitizeLarkCliError(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  return trimmed
    .replace(/app[_-]?secret\s*[:=]\s*\S+/gi, "appSecret=[redacted]")
    .replace(/secret\s*[:=]\s*\S+/gi, "secret=[redacted]")
    .replace(/token\s*[:=]\s*\S+/gi, "token=[redacted]")
    .slice(0, 500);
}

describe("profile error sanitization", () => {
  test("removes appSecret from stderr", () => {
    const stderr = "Error: app_secret=abc123xyz is invalid\n";
    expect(sanitizeLarkCliError(stderr)).not.toContain("abc123xyz");
    expect(sanitizeLarkCliError(stderr)).toContain("[redacted]");
  });

  test("removes token from stderr", () => {
    const stderr = "auth failed: token=secret-token-value\n";
    expect(sanitizeLarkCliError(stderr)).not.toContain("secret-token-value");
    expect(sanitizeLarkCliError(stderr)).toContain("[redacted]");
  });

  test("removes secret=value pattern", () => {
    const stderr = "config error: secret=mysecret123\n";
    expect(sanitizeLarkCliError(stderr)).not.toContain("mysecret123");
    expect(sanitizeLarkCliError(stderr)).toContain("[redacted]");
  });

  test("truncates to 500 chars", () => {
    const long = "x".repeat(1000);
    expect(sanitizeLarkCliError(long).length).toBe(500);
  });

  test("handles empty stderr", () => {
    expect(sanitizeLarkCliError("")).toBe("");
  });

  test("preserves normal error text", () => {
    const stderr = "connection refused on port 3000";
    expect(sanitizeLarkCliError(stderr)).toBe("connection refused on port 3000");
  });
});
