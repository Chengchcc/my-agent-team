import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVectorMemoryStore } from "@chengchenccc/embedding";
import { createHubTool } from "../coordination/hub-tool.js";
import { createDelegationTools } from "../delegation/tool.js";
import { createLearnTool } from "../memory/learn.js";
import { createRecallTool, createRetainTool } from "../memory/vector-tools.js";
import { createOrchestrateTool } from "../orchestrate/tool.js";
import { wrapperBackstopMs } from "../runtime/run-tools.js";
import { createBashTool } from "./bash.js";
import { MAX_BROWSER_TIMEOUT_MS } from "./browser.js";
import { parseFingerprint } from "./file-fingerprint.js";
import { createEditTool, createReadTool, createWriteTool } from "./file-tools.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createLsTool, createTreeTool } from "./ls-tree.js";
import { createReadImageTool } from "./read-image.js";
import { createSkill } from "./skill.js";
import { createStdWebFetchPort } from "./web-ports-std.js";

const tmpRoots: string[] = [];
const makeTmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};

const savedDenyPaths = process.env.OMA_DENY_WRITE_PATHS;
const savedFetch = globalThis.fetch;
afterEach(() => {
  if (savedDenyPaths === undefined) delete process.env.OMA_DENY_WRITE_PATHS;
  else process.env.OMA_DENY_WRITE_PATHS = savedDenyPaths;
  globalThis.fetch = savedFetch;
});
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("Built-in tools hardening (P0 + P1 + P2)", () => {
  test("grep supports case_insensitive, files_only, context, head_limit truncation, and AbortSignal", async () => {
    const ws = makeTmp("oma-grep-hard-");
    const lines = Array.from({ length: 40 }, (_, i) => `MatchLine ${i}`).join("\n");
    writeFileSync(join(ws, "a.txt"), lines);
    writeFileSync(join(ws, "b.txt"), "before\nTARGET_VALUE\nafter\n");

    const grep = createGrepTool({ workspaceRoot: ws });

    const capped = await grep.execute({ pattern: "MatchLine", head_limit: 5 });
    expect(capped.isError).toBeUndefined();
    expect(String(capped.content)).toContain("truncated at 5 lines");

    const ci = await grep.execute({ pattern: "target_value", case_insensitive: true, context: 1 });
    expect(String(ci.content)).toContain("before");
    expect(String(ci.content)).toContain("TARGET_VALUE");
    expect(String(ci.content)).toContain("after");

    const filesOnly = await grep.execute({ pattern: "TARGET_VALUE", files_only: true });
    expect(String(filesOnly.content).trim()).toEndWith("b.txt");
    expect(String(filesOnly.content)).not.toContain("TARGET_VALUE");

    const ac = new AbortController();
    ac.abort();
    const aborted = await grep.execute({ pattern: "MatchLine" }, ac.signal);
    expect(aborted.isError).toBe(true);
    expect(String(aborted.content)).toContain("aborted");
  });

  test("ls and tree enforce 500-entry caps and clamp tree max_depth", async () => {
    const ws = makeTmp("oma-lstree-cap-");
    for (let i = 0; i < 520; i++) {
      writeFileSync(join(ws, `f-${String(i).padStart(3, "0")}.txt`), "x");
    }

    const ls = createLsTool({ cwd: ws });
    const lsRes = await ls.execute({});
    expect(lsRes.isError).toBeUndefined();
    expect(String(lsRes.content)).toContain("truncated at 500 of 520 entries");

    const tree = createTreeTool({ cwd: ws });
    const treeRes = await tree.execute({ max_depth: 999 });
    expect(treeRes.isError).toBeUndefined();
    expect(String(treeRes.content)).toContain("truncated at 500 entries");
  });

  test("OMA_DENY_WRITE_PATHS blocks reads across read, read_image, grep, glob, ls, and tree", async () => {
    const ws = makeTmp("oma-deny-read-");
    mkdirSync(join(ws, "secrets"), { recursive: true });
    writeFileSync(join(ws, "secrets", ".env"), "SECRET_KEY=topsecret\n");
    writeFileSync(
      join(ws, "secrets", "shot.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
    );
    writeFileSync(join(ws, "public.txt"), "hello\n");

    process.env.OMA_DENY_WRITE_PATHS = `${join(ws, "secrets")}/`;

    const readRes = await createReadTool({ cwd: ws }).execute({ path: "secrets/.env" });
    expect(readRes.isError).toBe(true);
    expect(String(readRes.content)).toContain("OMA_DENY_WRITE_PATHS");

    const imgRes = await createReadImageTool({ cwd: ws }).execute({ path: "secrets/shot.png" });
    expect(imgRes.isError).toBe(true);

    const grepRes = await createGrepTool({ workspaceRoot: ws }).execute({
      pattern: "topsecret",
      path: "secrets",
    });
    expect(grepRes.isError).toBe(true);

    const lsRes = await createLsTool({ cwd: ws }).execute({ path: "secrets" });
    expect(lsRes.isError).toBe(true);

    const treeRes = await createTreeTool({ cwd: ws }).execute({ path: "secrets" });
    expect(treeRes.isError).toBe(true);

    const globRes = await createGlobTool({ workspaceRoot: ws }).execute({ pattern: "**/*" });
    expect(String(globRes.content)).toContain("public.txt");
    expect(String(globRes.content)).not.toContain("secrets");
  });

  test("write and edit return the updated [fingerprint] under freshness=require for chained edits", async () => {
    const ws = makeTmp("oma-fp-chain-");
    const writeTool = createWriteTool({ cwd: ws, freshness: "require" });
    const editTool = createEditTool({ cwd: ws, freshness: "require" });

    const w1 = await writeTool.execute({ path: "doc.txt", content: "alpha\nbeta\n" });
    expect(w1.isError).toBeUndefined();
    const fp1 = parseFingerprint(String(w1.content));
    expect(fp1).toBeTruthy();

    // Immediately edit using fingerprint returned by write — no extra read required!
    const e1 = await editTool.execute({
      path: "doc.txt",
      old_string: "alpha",
      new_string: "ALPHA",
      fingerprint: fp1,
    });
    expect(e1.isError).toBeUndefined();
    const fp2 = parseFingerprint(String(e1.content));
    expect(fp2).toBeTruthy();
    expect(fp2).not.toBe(fp1);

    // Chain a second edit immediately using fp2.
    const e2 = await editTool.execute({
      path: "doc.txt",
      old_string: "beta",
      new_string: "BETA",
      fingerprint: fp2,
    });
    expect(e2.isError).toBeUndefined();
    expect(readFileSync(join(ws, "doc.txt"), "utf8")).toBe("ALPHA\nBETA\n");
  });

  test("bash spills oversized foreground output to .oma/runs/ and strips case-insensitive/encryption secrets", async () => {
    const ws = makeTmp("oma-bash-hard-");
    const bash = createBashTool({ workspaceRoot: ws, scope: "bash-hard-test" });

    // Oversized output spills to disk while keeping head + tail inline.
    const big = await bash.execute({
      description: "emit 60KB",
      command: `bun -e 'console.log("HEAD_MARKER"); console.log("x".repeat(60000)); console.log("TAIL_MARKER")'`,
    });
    expect(big.isError).toBe(false);
    const content = String(big.content);
    expect(content).toContain("HEAD_MARKER");
    expect(content).toContain("TAIL_MARKER");
    expect(content).toContain("saved to .oma/runs/bash-");
    expect(content.length).toBeLessThan(35_000);
    const match = content.match(/\.oma\/runs\/bash-[^\s]+\.log/);
    expect(match).toBeTruthy();
    expect(existsSync(join(ws, match![0]))).toBe(true);

    // Secret env stripping covers lowercase api_key and ENCRYPTION_KEY / PRIVATE_KEY.
    process.env.MCP_ENCRYPTION_KEY = "super-secret-enc";
    process.env.custom_api_key = "super-secret-lower";
    process.env.MY_PRIVATE_KEY = "super-secret-priv";
    try {
      const envRes = await bash.execute({
        description: "check stripped env",
        command: `printf '%s|%s|%s' "$MCP_ENCRYPTION_KEY" "$custom_api_key" "$MY_PRIVATE_KEY"`,
      });
      expect(String(envRes.content)).toContain("||");
      expect(String(envRes.content)).not.toContain("super-secret");
    } finally {
      delete process.env.MCP_ENCRYPTION_KEY;
      delete process.env.custom_api_key;
      delete process.env.MY_PRIVATE_KEY;
    }
  });

  test("browser wrapper backstop matches MAX_BROWSER_TIMEOUT_MS (300s)", () => {
    expect(wrapperBackstopMs("browser")).toBe(MAX_BROWSER_TIMEOUT_MS);
    expect(wrapperBackstopMs("browser")).toBe(300_000);
  });

  test("retain redacts secrets before writing into vector memory DB", async () => {
    const ws = makeTmp("oma-retain-redact-");
    const store = openVectorMemoryStore(join(ws, "memory.db"));
    try {
      const retain = createRetainTool({ store, provider: null });
      const recall = createRecallTool({ store, provider: null });
      const res = await retain.execute({
        content: "Use Bearer abcdefghijklmnopqrstuvwxyz123456 and sk-proj1234567890abcdefghij",
        context: "token ghp_1234567890abcdefghijklmnop",
      });
      expect(res.isError).toBeUndefined();
      const hit = await recall.execute({ query: "Use redacted token" });
      const text = String(hit.content);
      expect(text).toContain("[redacted]");
      expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
      expect(text).not.toContain("sk-proj");
      expect(text).not.toContain("ghp_");
    } finally {
      store.close();
    }
  });

  test("web_fetch caps extracted text and cancels body stream on oversized responses", async () => {
    let cancelled = false;
    globalThis.fetch = (async () => {
      const encoder = new TextEncoder();
      const chunk = encoder.encode("A".repeat(100_000));
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 20) {
            controller.close();
            return;
          }
          sent++;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const ac = new AbortController();
    const out = await createStdWebFetchPort().fetch("https://example.com/huge", ac.signal);
    expect(cancelled).toBe(true);
    expect(out.text.length).toBeLessThan(49_000);
    expect(out.text).toContain("truncated at 48000 chars");
  });

  test("skill_load, hub, task, orchestrate, and learn all set isError: true on errors", async () => {
    const ws = makeTmp("oma-iserror-");

    const skillTool = createSkill({ roots: [ws] }).plugin.tools![0]!;
    expect((await skillTool.execute({ name: "missing" })).isError).toBe(true);

    const hub = createHubTool({
      scope: "s",
      list: () => [],
      get: () => undefined,
      wait: async () => ({ settled: [], timedOut: true }),
      stop: () => ({ ok: false, error: "not found" }),
      steer: () => ({ ok: false, error: "not running" }),
    })[0]!;
    expect((await hub.execute({ op: "output", id: "nope" })).isError).toBe(true);
    expect((await hub.execute({ op: "bogus" })).isError).toBe(true);
    expect((await hub.execute({ op: "stop", id: "nope" })).isError).toBe(true);

    const task = createDelegationTools({
      runBatch: async () => ({ ok: true, items: [] }),
      runSubagent: async () => ({ ok: true, label: "x", text: "" }),
      readAgentDefinition: async () => null,
    })[0]!;
    expect((await task.execute({ tasks: [] })).isError).toBe(true);
    expect((await task.execute({ agent: "nonexistent", prompt: "hi" })).isError).toBe(true);

    const orch = createOrchestrateTool({
      runScript: async () => ({
        ok: true,
        totalTokens: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        value: null,
        logs: [],
      }),
      writeScript: () => {},
      readScript: async () => null,
    })[0]!;
    expect((await orch.execute({})).isError).toBe(true);
    expect((await orch.execute({ name: "missing" })).isError).toBe(true);

    const learn = createLearnTool({ workspaceRoot: ws });
    expect((await learn.execute({ memory: "   " })).isError).toBe(true);
  });
});
