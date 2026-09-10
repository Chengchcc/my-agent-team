import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Env MUST be set before the bootstrap feature graph loads (the lark-bot
// registry parses process.env at module scope). Every import of that graph
// stays dynamic inside setupTestApp — same pattern as app.test.ts and
// bootstrap/features.test.ts.
process.env.BACKEND_AUTH_TOKEN = "test-token";
process.env.ANTHROPIC_API_KEY = "sk-test";

export const TOKEN = "test-token";

const modelsYml = `providers:
  anthropic:
    api: anthropic-messages
    apiKey: ANTHROPIC_API_KEY
    models:
      - id: claude-sonnet-4-6
        name: claude-sonnet-4-6
        maxTokens: 8192
`;

/** Minimal shape the route tests rely on (in-process Elysia handle). */
export interface TestApp {
  app: { handle(request: Request): Promise<Response> };
  /** Temp dir doubles as dataDir and workspaceRoot. */
  dataDir: string;
  dispose(): Promise<void>;
}

/**
 * Build the REAL backend (services → installFeatures → createApp) over a
 * throwaway sqlite + dataDir, and drive it through app.handle() — no port,
 * no network. Route-level tests exercise the true route plugins, the auth
 * gate and the onError translation exactly as production mounts them.
 */
export async function setupTestApp(opts?: {
  /** Files materialized into builtinSkillsDir BEFORE seeding, so the
   *  builtin skill pack lands ready on disk (path relative to the dir). */
  builtinSkills?: Record<string, string>;
}): Promise<TestApp> {
  const dir = mkdtempSync(`${tmpdir()}/be-routes-`);
  const builtinDir = `${dir}/builtin-skills`;
  mkdirSync(builtinDir, { recursive: true });
  writeFileSync(`${dir}/models.yml`, modelsYml);
  for (const [rel, content] of Object.entries(opts?.builtinSkills ?? {})) {
    const full = `${builtinDir}/${rel}`;
    mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    writeFileSync(full, content);
  }

  const cfg = {
    dataDir: dir,
    workspaceRoot: dir,
    templateDir: `${dir}/templates`,
    host: "127.0.0.1",
    port: 3000,
    authToken: TOKEN,
    cancelGraceMs: 100,
    maxConcurrentRuns: 4,
    builtinSkillsDir: builtinDir,
  };

  const { createBackendServices } = await import("../bootstrap/services.js");
  const services = createBackendServices(cfg as Parameters<typeof createBackendServices>[0]);
  const { installFeatures } = await import("../bootstrap/features.js");
  const installed = await installFeatures(services);
  const { createApp } = await import("../app.js");

  return {
    app: createApp(TOKEN, installed.featureSet),
    dataDir: dir,
    dispose: async () => {
      await installed.dispose();
      await services.mcpClientManager.disconnectAll();
      services.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Authenticated in-process request. Body is JSON-encoded when present. */
export function api(
  testApp: TestApp,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return testApp.app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "x-auth-token": TOKEN,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
