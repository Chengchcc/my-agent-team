import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [],
  // Self-contained server bundle: `next build` also emits .next/standalone
  // (server.js + the traced runtime), which is what the shipped artifact runs.
  // `next start` against .next still works unchanged.
  output: "standalone",
  // The app has zero next/image usages, so the optimizer buys nothing while
  // its optional sharp/libvips native deps (platform-specific, ~40MB) land in
  // the standalone trace. Turning it off keeps the artifact portable.
  images: { unoptimized: true },
  // The tracer follows static requires, not the runtime path, so sharp/libvips
  // land in the payload even with image optimization off — and they are the
  // only platform-specific binaries there (~33MB, linux-gnu + linux-musl).
  // Nothing needs them: no next/image in the app, unoptimized on top.
  outputFileTracingExcludes: {
    "*": [
      "**/node_modules/@img/**",
      "**/node_modules/sharp/**",
      // bun's isolated store nests deps one level deeper (.bun/<pkg>@<ver>/)
      "**/node_modules/.bun/@img*/**",
    ],
  },
  // Route renames (UI review 3.5): /work -> /today, /agentic-workflow ->
  // /workflows; team overview flip: /team/agents* -> /team* (agent detail
  // now lives at /team/[agentId]). Old paths keep working via redirects.
  async redirects() {
    return [
      { source: "/work", destination: "/today", permanent: false },
      { source: "/agentic-workflow", destination: "/workflows", permanent: false },
      { source: "/agentic-workflow/:path*", destination: "/workflows/:path*", permanent: false },
      { source: "/team/agents", destination: "/team", permanent: false },
      { source: "/team/agents/:agentId", destination: "/team/:agentId", permanent: false },
    ];
  },
  // The repo lints web with the root flat ESLint + Biome in `bun run lint`;
  // Next's built-in ESLint run has no eslint-config-next installed, so it
  // only emits a plugin-not-detected warning and double-runs lint for free.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
