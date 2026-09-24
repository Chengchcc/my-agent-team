import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModelRuntime,
  createOmaRuntime,
  createRuntimeTestContext,
  registerBuiltinProviders,
} from "./create-runtime.fixture.js";

const { tmp, runInput, cleanup } = createRuntimeTestContext();
afterAll(cleanup);
const withFakes = (fn: () => Promise<void>) => async () => {
  const saved = ["OMA_FAKE_PROVIDER", "OMA_FAKE_TOOL", "OMA_FAKE_TEXT"].map((k) => process.env[k]);
  process.env.OMA_FAKE_PROVIDER = "1";
  try {
    await fn();
  } finally {
    ["OMA_FAKE_PROVIDER", "OMA_FAKE_TOOL", "OMA_FAKE_TEXT"].forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
};

/** One auto-mode run against the fake provider: script drives the model's
 * tool call, OMA_FAKE_TEXT is the classifier verdict (the fake script
 * queue is empty by the time the gate's classifier call runs). Returns
 * the serialized outcome messages. */
const autoRun = async (opts: {
  runId: string;
  script: Array<{ name: string; input: Record<string, unknown> }>;
  text: string;
  permissionMode?: "ask" | "auto" | "deny";
  pluginTool?: { name: string; execute: () => Promise<Record<string, unknown>> };
  approvalHandler?: (req: {
    toolName: string;
    reason?: string;
    source?: string;
    sandboxed?: boolean;
  }) => Promise<{ decision: "allow" | "deny"; reason?: string }>;
  localMemory?: boolean;
  workspaceRoot?: string;
}): Promise<string> => {
  process.env.OMA_FAKE_TOOL = JSON.stringify(opts.script);
  process.env.OMA_FAKE_TEXT = opts.text;
  const modelRuntime = createModelRuntime();
  registerBuiltinProviders(modelRuntime, process.env);
  const pluginComponents = opts.pluginTool
    ? {
        plugins: [
          {
            name: "plugin:plug",
            tools: [
              {
                name: opts.pluginTool.name,
                description: "plugin tool",
                inputSchema: { type: "object", properties: {}, required: [] },
                execute: opts.pluginTool.execute,
              },
            ],
          },
        ],
      }
    : undefined;
  const runtimeOpts: Parameters<typeof createOmaRuntime>[0] = {
    runId: opts.runId,
    modelId: "fake/echo",
    workspaceRoot: opts.workspaceRoot ?? tmp,
    workspaceAccess: "read_write",
    modelRuntime,
    skillRoots: [],
  };
  if (opts.permissionMode) runtimeOpts.permissionMode = opts.permissionMode;
  if (pluginComponents) runtimeOpts.pluginComponents = pluginComponents;
  if (opts.approvalHandler) runtimeOpts.approvalHandler = opts.approvalHandler as never;
  if (opts.localMemory) runtimeOpts.localMemory = true;
  const rt = await createOmaRuntime(runtimeOpts);
  const seg = await rt.run(runInput(opts.runId));
  const out = await seg.outcome;
  await rt.close();
  return JSON.stringify(out.messages);
};

describe("permissionMode auto classifier gate (CC alignment)", () => {
  test(
    "classifier allow executes bash; block denies with the reason",
    withFakes(async () => {
      const script = [
        { name: "bash", input: { description: "d", command: "echo x > marker-auto.txt" } },
      ];
      const allowed = await autoRun({
        runId: "r-auto-allow",
        script,
        text: '{"verdict":"allow"}',
        permissionMode: "auto",
      });
      expect(allowed).not.toContain("blocked by classifier");
      expect(existsSync(join(tmp, "marker-auto.txt"))).toBe(true);

      const blocked = await autoRun({
        runId: "r-auto-block",
        script,
        text: '{"verdict":"block","reason":"deletes home files"}',
        permissionMode: "auto",
      });
      expect(blocked).toContain("blocked by classifier");
      expect(blocked).toContain("deletes home files");
    }),
  );

  test(
    "write skips the classifier (workspace-sandboxed)",
    withFakes(async () => {
      const out = await autoRun({
        runId: "r-auto-write",
        script: [{ name: "write", input: { description: "d", path: "w-auto.txt", content: "hi" } }],
        // The classifier would block everything — write must not consult it.
        text: '{"verdict":"block","reason":"never"}',
        permissionMode: "auto",
      });
      expect(out).not.toContain("blocked by classifier");
      expect(existsSync(join(tmp, "w-auto.txt"))).toBe(true);
    }),
  );

  test(
    "absent permissionMode stays ungated (legacy standalone default)",
    withFakes(async () => {
      const out = await autoRun({
        runId: "r-auto-absent",
        script: [
          { name: "bash", input: { description: "d", command: "echo y > marker-absent.txt" } },
        ],
        text: '{"verdict":"block","reason":"never"}',
      });
      expect(out).not.toContain("blocked by classifier");
      expect(existsSync(join(tmp, "marker-absent.txt"))).toBe(true);
    }),
  );

  test(
    "plugin code tools are classified under auto",
    withFakes(async () => {
      let executed = false;
      const out = await autoRun({
        runId: "r-auto-plugin",
        script: [{ name: "plug-hello", input: {} }],
        text: '{"verdict":"block","reason":"untrusted plugin effect"}',
        permissionMode: "auto",
        pluginTool: {
          name: "plug-hello",
          execute: async () => {
            executed = true;
            return { content: "PLUG-OK" };
          },
        },
      });
      expect(out).toContain("blocked by classifier");
      expect(out).toContain("untrusted plugin effect");
      expect(executed).toBe(false);
    }),
  );

  test(
    "a classifier block escalates to the human ONCE per unique action",
    withFakes(async () => {
      const escalations: string[] = [];
      const bash = {
        name: "bash",
        input: { description: "d", command: "echo z > marker-esc.txt" },
      };
      const out = await autoRun({
        runId: "r-auto-escalate",
        // Three identical calls; the classifier consumes script slots, so:
        // call1 pops bash#1, its classifier pops bash#2 (tool_use stream →
        // no verdict → block) → escalates → human allows → executes;
        // call2 pops bash#3, its classifier reads the text verdict → block
        // → dedupe: silent deny, no second card; call3 ends the turn.
        script: [bash, bash, bash],
        text: '{"verdict":"block","reason":"looks destructive"}',
        permissionMode: "auto",
        approvalHandler: async (req) => {
          escalations.push(`${req.source}:${req.toolName}`);
          return { decision: "allow" };
        },
      });
      // Exactly ONE escalation: first occurrence human-overridden → executed.
      expect(escalations).toEqual(["classifier:bash"]);
      expect(existsSync(join(tmp, "marker-esc.txt"))).toBe(true);
      // Second identical occurrence: denied again with the text verdict
      // (every denial is reported to the model) but WITHOUT a second card.
      expect(out).toContain("blocked by classifier — looks destructive");
      expect(out.match(/blocked by classifier/g)?.length).toBe(2);
    }),
  );

  test(
    "human denial keeps the block; critical-path rm never escalates and never runs",
    withFakes(async () => {
      let escalations = 0;
      const denied = await autoRun({
        runId: "r-auto-human-deny",
        script: [{ name: "bash", input: { description: "d", command: "echo a > marker-hd.txt" } }],
        text: '{"verdict":"block","reason":"risky"}',
        permissionMode: "auto",
        approvalHandler: async () => {
          escalations++;
          return { decision: "deny" };
        },
      });
      expect(denied).toContain("(human denied)");
      expect(existsSync(join(tmp, "marker-hd.txt"))).toBe(false);

      // Critical deletion: hard block BEFORE the classifier (verdict would
      // allow) and BEFORE any human card.
      const critical = await autoRun({
        runId: "r-auto-critical",
        script: [{ name: "bash", input: { description: "d", command: "rm -rf /" } }],
        text: '{"verdict":"allow"}',
        permissionMode: "auto",
        approvalHandler: async () => {
          escalations++;
          return { decision: "allow" };
        },
      });
      expect(critical).toContain("critical-path deletion");
      expect(critical).not.toContain("(human denied)");
      expect(escalations).toBe(1); // only the human-deny case escalated
    }),
  );

  test(
    "browser gates like bash: deny blocks outright, auto consults the classifier",
    withFakes(async () => {
      const call = [{ name: "browser", input: { action: "open", url: "about:blank" } }];
      const denied = await autoRun({
        runId: "r-browser-deny",
        script: call,
        text: '{"verdict":"allow"}',
        permissionMode: "deny",
      });
      expect(denied).toContain("browser: blocked by permissionMode=deny");

      const auto = await autoRun({
        runId: "r-browser-auto",
        script: call,
        text: '{"verdict":"block","reason":"no browsing in this run"}',
        permissionMode: "auto",
      });
      expect(auto).toContain("blocked by classifier");
      expect(auto).toContain("no browsing in this run");
    }),
  );
});

/** BashSandbox design P4: the approval card must report the Run's REAL
 * sandbox state. A stale hardcoded `sandboxed: false` would tell the human
 * "unsandboxed" while bwrap/Seatbelt is actually confining the command (or
 * the reverse) — the badge is a signal, never an auto-allow basis. */
describe("ask-mode bash approval reports the real OS-sandbox state", () => {
  const HAS_BWRAP = Bun.which("bwrap") !== null;

  const askRun = (opts: {
    runId: string;
    workspaceRoot: string;
    seen: Array<boolean | undefined>;
  }) =>
    autoRun({
      runId: opts.runId,
      workspaceRoot: opts.workspaceRoot,
      script: [{ name: "bash", input: { description: "d", command: "echo sbx-probe" } }],
      text: "",
      permissionMode: "ask",
      approvalHandler: async (req) => {
        opts.seen.push(req.sandboxed);
        return { decision: "allow" };
      },
    });

  test(
    "no sandbox configured: sandboxed is false (explicit, not absent)",
    withFakes(async () => {
      const seen: Array<boolean | undefined> = [];
      const ws = mkdtempSync(join(tmpdir(), "oma-ask-sbx-off-"));
      try {
        await askRun({ runId: "r-ask-sbx-off", workspaceRoot: ws, seen });
        expect(seen).toEqual([false]);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    }),
  );

  (HAS_BWRAP ? test : test.skip)(
    "settings bashSandbox:true: sandboxed is true",
    withFakes(async () => {
      const seen: Array<boolean | undefined> = [];
      const ws = mkdtempSync(join(tmpdir(), "oma-ask-sbx-on-"));
      try {
        mkdirSync(join(ws, ".oma"), { recursive: true });
        writeFileSync(join(ws, ".oma", "settings.json"), JSON.stringify({ bashSandbox: true }));
        await askRun({ runId: "r-ask-sbx-on", workspaceRoot: ws, seen });
        expect(seen).toEqual([true]);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    }),
    20_000,
  );
});

/** The product mounts were exempt from the gate by SERVER NAME
 *  (`startsWith("mcp__product-tools__")`), so every tool they exposed inherited
 *  it — including the two that write outside the workspace, which therefore ran
 *  ungated even under permissionMode "deny". The exemption is now an explicit
 *  list of consented capabilities (reads + the run's own scratch/interaction
 *  state), and anything else a product server exposes is gated by default. */
describe("product-mounted tools are gated by capability, not by server name", () => {
  /** Mounts `product-tools` from the echo fixture with the given tool names. */
  async function productMount(opts: {
    runId: string;
    tools: string;
    permissionMode: "ask" | "auto" | "deny";
    call: string;
    text?: string;
    echoText?: string;
    /** Skip the injected consent (the fail-safe default case). */
    noConsent?: boolean;
  }): Promise<string> {
    // Save/restore the fake-provider env, like every other test in this file.
    // bun runs every test FILE in ONE process, so an unrestored OMA_FAKE_TEXT
    // leaks into whatever loads next — the TUI e2e suites then answer with this
    // verdict string instead of their own scripted text (they run in the same
    // process under the full app suite, and only then does it show up).
    const ENV_KEYS = [
      "OMA_FAKE_PROVIDER",
      "MCP_ECHO_TOOLS",
      "OMA_FAKE_TOOL",
      "OMA_FAKE_TEXT",
      "OMA_CONSENTED_MCP_TOOLS",
    ];
    const savedEnv = ENV_KEYS.map((k) => process.env[k]);
    process.env.OMA_FAKE_PROVIDER = "1";
    process.env.MCP_ECHO_TOOLS = opts.tools;
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: `mcp__product-tools__${opts.call}`, input: { echo: opts.echoText ?? "x" } },
    ]);
    process.env.OMA_FAKE_TEXT = opts.text ?? "";
    // Simulate the SPAWNER: the product's consented reads arrive as
    // injected policy, exactly what the backend adapter forwards.
    if (opts.noConsent) delete process.env.OMA_CONSENTED_MCP_TOOLS;
    else {
      process.env.OMA_CONSENTED_MCP_TOOLS = [
        "mcp__product-tools__history_recent",
        "mcp__product-tools__history_search",
        "mcp__product-tools__history_around",
        "mcp__product-tools__history_retain",
        "mcp__product-tools__artifact_download",
        "mcp__product-tools__todo_write",
        "mcp__product-tools__ask_question",
      ].join(",");
    }
    const ws = mkdtempSync(join(tmpdir(), "oma-product-gate-"));
    writeFileSync(
      join(ws, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "product-tools": {
            command: "bun",
            args: [join(import.meta.dir, "../__fixtures__/mcp-echo-server.ts")],
            env: { MCP_ECHO_TOOLS: opts.tools },
          },
        },
      }),
    );
    const modelRuntime = createModelRuntime();
    registerBuiltinProviders(modelRuntime, process.env);
    const rt = await createOmaRuntime({
      runId: opts.runId,
      modelId: "fake/echo",
      workspaceRoot: ws,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
      permissionMode: opts.permissionMode,
    });
    try {
      const seg = await rt.run(runInput(opts.runId));
      const out = await seg.outcome;
      return JSON.stringify(out.messages);
    } finally {
      await rt.close();
      ENV_KEYS.forEach((k, i) => {
        const prev = savedEnv[i];
        if (prev === undefined) delete process.env[k];
        else process.env[k] = prev;
      });
      try {
        rmSync(ws, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  /** Test hygiene, pinned: bun runs every file in ONE process, so a helper
   *  that leaves OMA_FAKE_* set changes the model replies of whatever test
   *  file loads next. That is not hypothetical — it turned 19 TUI tests red in
   *  the combined suite while each suite passed alone. */
  test("productMount restores the fake-provider env it sets", async () => {
    const KEYS = [
      "OMA_FAKE_PROVIDER",
      "MCP_ECHO_TOOLS",
      "OMA_FAKE_TOOL",
      "OMA_FAKE_TEXT",
      "OMA_CONSENTED_MCP_TOOLS",
    ];
    const before = KEYS.map((k) => process.env[k]);
    await productMount({
      runId: "r-prod-env",
      tools: "history_recent",
      permissionMode: "deny",
      call: "history_recent",
    });
    expect(KEYS.map((k) => process.env[k])).toEqual(before);
  });

  /** Fail-safe default: oma holds no product names, so WITHOUT the
   *  spawner's injected consent even a product-shaped read is gated. */
  test("no injected consent → even a product read is gated (fail-safe)", async () => {
    const saved = process.env.OMA_CONSENTED_MCP_TOOLS;
    try {
      const out = await productMount({
        runId: "r-prod-noconsent",
        tools: "history_recent",
        permissionMode: "deny",
        call: "history_recent",
        noConsent: true,
      });
      expect(out).toContain("blocked by permissionMode=deny");
    } finally {
      if (saved === undefined) delete process.env.OMA_CONSENTED_MCP_TOOLS;
      else process.env.OMA_CONSENTED_MCP_TOOLS = saved;
    }
  });

  test("deny: a consented read runs, a product WRITE is blocked", async () => {
    // artifact_upload writes backend artifact storage: not a read, not
    // consented, so deny must actually deny it.
    const blocked = await productMount({
      runId: "r-prod-deny-write",
      tools: "artifact_upload",
      permissionMode: "deny",
      call: "artifact_upload",
    });
    expect(blocked).toContain("blocked by permissionMode=deny");
    // The tool never ran. The echo fixture's RESULT carries "meta" (its args
    // alone would too, so the marker must be result-only).
    expect(blocked).not.toContain("meta");

    // history_recent is a read of the run's own conversation: still consented.
    const allowed = await productMount({
      runId: "r-prod-deny-read",
      tools: "history_recent",
      permissionMode: "deny",
      call: "history_recent",
    });
    expect(allowed).toContain("meta"); // the fixture answered
    expect(allowed).not.toContain("blocked by permissionMode=deny");

    // history_retain WRITES the ledger, but the product already consented to
    // it: the backend's workspace bridge pre-allows exactly
    // history_recent/search/around/retain so unattended runs never see an
    // approval prompt. Gating it here would put a card (or a deadline deny) in
    // front of an ordinary product run.
    const retained = await productMount({
      runId: "r-prod-deny-retain",
      tools: "history_retain",
      permissionMode: "deny",
      call: "history_retain",
    });
    expect(retained).toContain("meta");
    expect(retained).not.toContain("blocked by permissionMode=deny");
  });

  test("auto: a product WRITE is classified, a consented read is not", async () => {
    // The classifier answers from OMA_FAKE_TEXT; a block verdict must reach the
    // tool as an error, which proves the call was classified at all.
    const classified = await productMount({
      runId: "r-prod-auto-write",
      tools: "artifact_upload",
      permissionMode: "auto",
      call: "artifact_upload",
      text: '{"verdict":"block","reason":"product artifact write"}',
    });
    expect(classified).toContain("blocked by classifier");
    // The classifier's reason rides the tool result, and the tool never ran.
    expect(classified).toContain("product artifact write");
    expect(classified).not.toContain("meta");

    // history_search is a consented read: the classifier must NOT be consulted,
    // so its "block everything" verdict never reaches the tool.
    const notClassified = await productMount({
      runId: "r-prod-auto-read",
      tools: "history_search",
      permissionMode: "auto",
      call: "history_search",
      text: '{"verdict":"block","reason":"never"}',
    });
    expect(notClassified).not.toContain("blocked by classifier");
    expect(notClassified).toContain("meta"); // the fixture answered
  });

  /** yolo = the industry's skip-permissions mode: the judgment gate is OFF
   *  entirely (no classifier, no cards), so even artifact_upload — which deny
   *  blocks and auto classifies — runs. Static tool-layer boundaries are NOT
   *  part of this gate and stay on (pinned by their own suites). */
  test("yolo: high-risk product tools run ungated", async () => {
    const ran = await productMount({
      runId: "r-prod-yolo-write",
      tools: "artifact_upload",
      permissionMode: "yolo",
      call: "artifact_upload",
    });
    expect(ran).toContain("meta"); // the fixture answered: the tool RAN
    expect(ran).not.toContain("blocked by");
    expect(ran).not.toContain("approval");
  });
});

test("injected MCP todo_write wins over native todo (backend-injected priority)", async () => {
  const savedFake = process.env.OMA_FAKE_PROVIDER;
  const savedTool = process.env.OMA_FAKE_TOOL;
  const savedRecord = process.env.OMA_FAKE_TOOLS_RECORD;
  process.env.OMA_FAKE_PROVIDER = "1";
  // Model calls the mounted MCP tool by its qualified mcp__ name; the echo
  // fixture (via .mcp.json) answers (content "ok:todo_write").
  process.env.OMA_FAKE_TOOL = JSON.stringify([
    { name: "mcp__echo-server__todo_write", input: { items: [] } },
  ]);
  const ws = mkdtempSync(join(tmpdir(), "oma-todo-mcp-"));
  const toolsRecord = join(ws, "tools-record.json");
  process.env.OMA_FAKE_TOOLS_RECORD = toolsRecord;
  try {
    process.env.MCP_ECHO_TOOLS = "todo_write";
    writeFileSync(
      join(ws, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "echo-server": {
            command: "bun",
            args: [join(import.meta.dir, "../__fixtures__/mcp-echo-server.ts")],
            env: { MCP_ECHO_TOOLS: "todo_write" },
          },
        },
      }),
    );
    const modelRuntime = createModelRuntime();
    registerBuiltinProviders(modelRuntime, process.env);
    const rt = await createOmaRuntime({
      runId: "r-todo-mcp",
      modelId: "fake/echo",
      workspaceRoot: ws,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
    });
    const segment = await rt.run(runInput("r-todo-mcp"));
    const outcome = await segment.outcome;
    await rt.close();
    expect(outcome.status).toBe("completed");
    const raw = JSON.stringify(outcome.messages);
    // The MCP echo server answered (it echoes {name,...}); native todo
    // would have written .oma/todo.json instead.
    expect(raw).toContain("todo_write");
    expect(existsSync(join(ws, ".oma", "todo.json"))).toBe(false);

    // The assertion with teeth. The two above hold even when the conflict
    // rule is dead: the scripted call names the MCP tool, so that tool answers
    // and the native one just sits there unused — which is exactly what
    // happened in production, where the rule compared a bare `todo_write`
    // against the canonical `mcp__product-tools__todo_write` and therefore
    // never matched. What the rule actually controls is the ADVERTISED table:
    // when an injected todo exists, the model must not see a second,
    // workspace-global todo tool next to it (that one's file is shared by
    // every session in the workspace, so one conversation's task list leaked
    // into another's run).
    const advertised = JSON.parse(readFileSync(toolsRecord, "utf8")) as string[];
    expect(advertised).toContain("mcp__echo-server__todo_write");
    expect(advertised).not.toContain("todo_write");
  } finally {
    if (savedRecord === undefined) delete process.env.OMA_FAKE_TOOLS_RECORD;
    else process.env.OMA_FAKE_TOOLS_RECORD = savedRecord;
    delete process.env.MCP_ECHO_TOOLS;
    if (savedFake === undefined) delete process.env.OMA_FAKE_PROVIDER;
    else process.env.OMA_FAKE_PROVIDER = savedFake;
    if (savedTool === undefined) delete process.env.OMA_FAKE_TOOL;
    else process.env.OMA_FAKE_TOOL = savedTool;
    rmSync(ws, { recursive: true, force: true });
  }
});

test("--tools filter: whitelist hides unlisted tools from the model", async () => {
  const savedFake = process.env.OMA_FAKE_PROVIDER;
  process.env.OMA_FAKE_PROVIDER = "1";
  process.env.OMA_FAKE_TOOLS_RECORD = join(tmp, "tools-record.json");
  try {
    const modelRuntime = createModelRuntime();
    registerBuiltinProviders(modelRuntime, process.env);
    const { parseToolFilter } = await import("./tool-filter.js");
    const rt = await createOmaRuntime({
      runId: "r-tools-filter",
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
      toolFilter: parseToolFilter("read,write"),
    });
    const segment = await rt.run(runInput("r-tools-filter"));
    await segment.outcome;
    await rt.close();
    const table = JSON.parse(await Bun.file(join(tmp, "tools-record.json")).text()) as string[];
    expect(table).toContain("read");
    expect(table).toContain("write");
    expect(table).not.toContain("bash");
    expect(table).not.toContain("web_search");
  } finally {
    delete process.env.OMA_FAKE_TOOLS_RECORD;
    if (savedFake === undefined) delete process.env.OMA_FAKE_PROVIDER;
    else process.env.OMA_FAKE_PROVIDER = savedFake;
  }
});

test("--tools filter: blacklist (!name) keeps everything else", async () => {
  const savedFake = process.env.OMA_FAKE_PROVIDER;
  process.env.OMA_FAKE_PROVIDER = "1";
  process.env.OMA_FAKE_TOOLS_RECORD = join(tmp, "tools-record2.json");
  try {
    const modelRuntime = createModelRuntime();
    registerBuiltinProviders(modelRuntime, process.env);
    const { parseToolFilter } = await import("./tool-filter.js");
    const rt = await createOmaRuntime({
      runId: "r-tools-deny",
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
      toolFilter: parseToolFilter("!bash,!web_search"),
    });
    const segment = await rt.run(runInput("r-tools-deny"));
    await segment.outcome;
    await rt.close();
    const table = JSON.parse(await Bun.file(join(tmp, "tools-record2.json")).text()) as string[];
    expect(table).not.toContain("bash");
    expect(table).not.toContain("web_search");
    expect(table).toContain("read");
  } finally {
    delete process.env.OMA_FAKE_TOOLS_RECORD;
    if (savedFake === undefined) delete process.env.OMA_FAKE_PROVIDER;
    else process.env.OMA_FAKE_PROVIDER = savedFake;
  }
});

describe("local memory tools under the permission gate", () => {
  const withAgentDir = (fn: (agent: string) => Promise<void>) => async () => {
    const agent = mkdtempSync(join(tmpdir(), "oma-gate-agent-"));
    const saved = process.env.OMA_CODING_AGENT_DIR;
    process.env.OMA_CODING_AGENT_DIR = agent;
    try {
      await fn(agent);
    } finally {
      if (saved === undefined) delete process.env.OMA_CODING_AGENT_DIR;
      else process.env.OMA_CODING_AGENT_DIR = saved;
      rmSync(agent, { recursive: true, force: true });
    }
  };
  const fakes = (fn: () => Promise<void>) => async () => {
    const saved = ["OMA_FAKE_PROVIDER", "OMA_FAKE_TOOL", "OMA_FAKE_TEXT"].map(
      (k) => process.env[k],
    );
    process.env.OMA_FAKE_PROVIDER = "1";
    try {
      await fn();
    } finally {
      saved.forEach((v, i) => {
        const k = ["OMA_FAKE_PROVIDER", "OMA_FAKE_TOOL", "OMA_FAKE_TEXT"][i]!;
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
    }
  };

  test(
    "ask: learn and manage_skill route through the approval pipeline; deny blocks the write",
    fakes(
      withAgentDir(async (agent) => {
        process.env.OMA_FAKE_TOOL = JSON.stringify([
          { name: "learn", input: { memory: "gated lesson" } },
          {
            name: "manage_skill",
            input: { action: "create", name: "gated", description: "d", body: "b" },
          },
        ]);
        process.env.OMA_FAKE_TEXT = "done";
        const modelRuntime = createModelRuntime();
        registerBuiltinProviders(modelRuntime, process.env);
        const rt = await createOmaRuntime({
          runId: "r-learn-gate",
          modelId: "fake/echo",
          workspaceRoot: tmp,
          workspaceAccess: "read_write",
          modelRuntime,
          skillRoots: [],
          localMemory: true,
          permissionMode: "ask",
          approvalHandler: async () => ({ decision: "deny", reason: "not allowed" }),
        });
        const out = await (await rt.run(runInput("r-learn-gate"))).outcome;
        await rt.close();
        const raw = JSON.stringify(out.messages);
        expect(raw).toContain("denied");
        // Blocked BEFORE execution: neither write happened.
        expect(existsSync(join(agent, "managed-skills", "gated"))).toBe(false);
        expect(existsSync(join(tmp, ".oma", "memory", "learned.md"))).toBe(false);
      }),
    ),
  );

  test(
    "auto: plain learn stays ungated; the skill branch routes through the classifier",
    fakes(
      withAgentDir(async (agent) => {
        process.env.OMA_FAKE_TOOL = JSON.stringify([
          { name: "learn", input: { memory: "plain lesson" } },
          {
            name: "learn",
            input: {
              memory: "skill lesson",
              skill: { action: "create", name: "cls", description: "d", body: "B" },
            },
          },
        ]);
        // The fake script is exhausted by the time the classifier's stream
        // call runs, so this text doubles as the classifier verdict.
        process.env.OMA_FAKE_TEXT = '{"verdict":"allow"}';
        const modelRuntime = createModelRuntime();
        registerBuiltinProviders(modelRuntime, process.env);
        const rt = await createOmaRuntime({
          runId: "r-learn-cls",
          modelId: "fake/echo",
          workspaceRoot: tmp,
          workspaceAccess: "read_write",
          modelRuntime,
          skillRoots: [],
          localMemory: true,
          permissionMode: "auto",
        });
        await (await rt.run(runInput("r-learn-cls"))).outcome;
        await rt.close();
        // Plain lesson: no gate, file written.
        expect(existsSync(join(tmp, ".oma", "memory", "learned.md"))).toBe(true);
        // Skill branch: classifier allowed -> managed skill minted.
        expect(existsSync(join(agent, "managed-skills", "cls", "SKILL.md"))).toBe(true);
      }),
    ),
  );

  test(
    "auto: manage_skill blocked by a fail-closed classifier verdict",
    fakes(
      withAgentDir(async (agent) => {
        process.env.OMA_FAKE_TOOL = JSON.stringify([
          {
            name: "manage_skill",
            input: { action: "create", name: "blocked", description: "d", body: "b" },
          },
        ]);
        process.env.OMA_FAKE_TEXT = "garbage the classifier cannot parse";
        const modelRuntime = createModelRuntime();
        registerBuiltinProviders(modelRuntime, process.env);
        const rt = await createOmaRuntime({
          runId: "r-ms-cls",
          modelId: "fake/echo",
          workspaceRoot: tmp,
          workspaceAccess: "read_write",
          modelRuntime,
          skillRoots: [],
          localMemory: true,
          permissionMode: "auto",
        });
        const out = await (await rt.run(runInput("r-ms-cls"))).outcome;
        await rt.close();
        const raw = JSON.stringify(out.messages);
        expect(raw).toContain("blocked by classifier");
        expect(existsSync(join(agent, "managed-skills", "blocked"))).toBe(false);
      }),
    ),
  );

  test(
    "without localMemory (product RPC shape) the local memory tools are not mounted",
    fakes(async () => {
      process.env.OMA_FAKE_TOOL = JSON.stringify([{ name: "learn", input: { memory: "x" } }]);
      process.env.OMA_FAKE_TEXT = "done";
      const modelRuntime = createModelRuntime();
      registerBuiltinProviders(modelRuntime, process.env);
      const rt = await createOmaRuntime({
        runId: "r-learn-absent",
        modelId: "fake/echo",
        workspaceRoot: tmp,
        workspaceAccess: "read_write",
        modelRuntime,
        skillRoots: [],
        // localMemory deliberately NOT set (rpc-mode never passes it)
      });
      const out = await (await rt.run(runInput("r-learn-absent"))).outcome;
      await rt.close();
      expect(JSON.stringify(out.messages)).toContain("Unknown tool: learn");
    }),
  );
});
