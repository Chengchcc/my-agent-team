import { existsSync } from "node:fs";
import type { LoopAction, LoopConfig, LoopState } from "@my-agent-team/loop";
import {
  formatInboxMd,
  formatStateMd,
  loopReducer,
  parseInboxMd,
  parseLoopConfig,
  parseStateMd,
  parseVerdictMd,
} from "@my-agent-team/loop";
import type { ProjectPort } from "../project/ports.js";
import { nodeFsAdapter } from "../skill-pack/fs-adapter.js";
import type { SessionFactory, SessionSpec } from "../span/session-factory.js";
import type { SkillRoots } from "../span/skill-roots.js";

type ReviewAction = {
  itemId: string;
  verdict: "approve" | "reject" | "promote" | "retry" | "dismiss";
  feedback?: string;
};

export interface LoopStepParams {
  loopConfigPath: string;
  sessionFactory: SessionFactory;
  buildSpec: (params: {
    sessionId: string;
    modelName: string;
    cwd: string;
    skillRoots?: import("../span/skill-roots.js").SkillRoots;
  }) => SessionSpec;
  action?: ReviewAction;
  projectPort?: ProjectPort;
  dataDir?: string;
}

// === per-loop write lock ===
const loopLocks = new Map<string, Promise<unknown>>();
async function withLoopLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = loopLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, (err: unknown) => {
    loopLocks.delete(key);
    throw err;
  });
  loopLocks.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

// === per-loop daily budget counter ===
const budgetCounters = new Map<string, number>();

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function loadBudget(p: string, key: string): Promise<number> {
  const cached = budgetCounters.get(key);
  if (cached !== undefined) return cached;
  try {
    const raw = (await Bun.file(`${p}/budget.json`).json()) as Record<string, number>;
    const value = Number(raw[key] ?? 0);
    budgetCounters.set(key, value);
    return value;
  } catch {
    return 0;
  }
}

async function addBudget(p: string, key: string, delta: number): Promise<number> {
  const next = (budgetCounters.get(key) ?? 0) + (Number.isFinite(delta) ? delta : 0);
  budgetCounters.set(key, next);
  try {
    const path = `${p}/budget.json`;
    let obj: Record<string, number> = {};
    try {
      obj = (await Bun.file(path).json()) as Record<string, number>;
    } catch {}
    obj[key] = next;
    await Bun.write(path, JSON.stringify(obj));
  } catch {}
  return next;
}

async function tallyUsage(spec: SessionSpec, sessionId: string): Promise<number> {
  const cp = spec.checkpointer as {
    readEvents?: (
      sessionId: string,
    ) => AsyncIterable<{ type: string; usage?: { input?: number; output?: number } }>;
  };
  if (typeof cp?.readEvents !== "function") return 0;
  let total = 0;
  try {
    for await (const ev of cp.readEvents(sessionId)) {
      if (ev.type === "model_end" && ev.usage) {
        total += (ev.usage.input ?? 0) + (ev.usage.output ?? 0);
      }
    }
  } catch {}
  return total;
}

// === denylist glob matching ===
function matchesGlob(path: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexBody = escaped
    .replace(/\*\*/g, "[DBL]")
    .replace(/\*/g, "[^/]*")
    .split("[DBL]")
    .join(".*");
  return new RegExp(`^${regexBody}$`).test(path);
}

function denylistedFiles(files: string[], patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  return files.filter((f) => patterns.some((p) => matchesGlob(f, p)));
}

const GENERATOR_PROMPT = [
  "你是一个修 bug 的工程师。只改相关文件，不要重构无关代码。",
  "绝对不能 commit 或 push。",
  "",
  "当前任务:",
  "- 问题: {summary}",
  "- 来源: {source}",
  "{rejectionNote}",
].join("\n");

const EVALUATOR_PROMPT = [
  "你是验证者。立场：假定修复是坏的，直到证明能跑。",
  "",
  "你要做:",
  "1. 跑项目测试",
  "2. 用 git diff 确认只改了相关文件",
  "3. 对照验收标准判断",
  "",
  "验收标准: {acceptance}",
  "Generator 改了这些文件: {filesChanged}",
  "",
  "将判决写入工作区根目录的 VERDICT.md，格式:",
  "---",
  "verdict: PASS|REJECT|ESCALATE",
  'reasons: 原因（REJECT/ESCALATE 时必填，JSON 数组，如 ["原因一", "原因二"]）',
  "evidence: 你跑了什么、结果是什么",
  "---",
].join("\n");

const ACCEPTANCE = "被修改的文件相关测试全绿，改动范围合理";
const GENERATOR_MODEL = "claude-sonnet-4";
const EVALUATOR_MODEL = "claude-opus-4";
const LOOP_AGENT_ID = "loop-agent";

async function resolveRepoPath(
  loopConfigPath: string,
  projectPort: ProjectPort | undefined,
  dataDir: string | undefined,
): Promise<string | null> {
  if (!projectPort || !dataDir) return null;
  let cfg: LoopConfig | null = null;
  try {
    cfg = parseLoopConfig(await Bun.file(`${loopConfigPath}/LOOP.md`).text());
  } catch {
    return null;
  }
  const projectId = cfg?.projectId;
  if (!projectId) return null;
  const project = projectPort.getProject(projectId);
  if (!project?.repoUrl) {
    throw new Error(`loopStep: project ${projectId} has no repoUrl`);
  }
  const repoPath = `${dataDir}/repos/${projectId}`;
  const branch = project.defaultBranch ?? "main";
  if (!existsSync(repoPath)) {
    await Bun.$`git clone --depth 1 --branch ${branch} ${project.repoUrl} ${repoPath}`.quiet();
  } else {
    await Bun.$`git fetch origin`.cwd(repoPath).quiet();
    await Bun.$`git checkout ${branch}`.cwd(repoPath).quiet();
    await Bun.$`git reset --hard origin/${branch}`.cwd(repoPath).quiet();
  }
  const ok =
    (await Bun.$`git -C ${repoPath} rev-parse --is-inside-work-tree`.quiet().nothrow()).exitCode ===
    0;
  if (!ok) throw new Error(`loopStep: repoPath is not a git work tree: ${repoPath}`);
  return repoPath;
}

function actionToReducer(action: ReviewAction): LoopAction {
  switch (action.verdict) {
    case "approve":
      return { type: "APPROVE", itemId: action.itemId };
    case "reject":
      return {
        type: "REJECT_HUMAN",
        itemId: action.itemId,
        feedback: action.feedback,
      };
    case "promote":
      return { type: "PROMOTE", itemId: action.itemId };
    case "retry":
      return { type: "RETRY", itemId: action.itemId };
    case "dismiss":
      return { type: "DISMISS", itemId: action.itemId };
  }
}

function pruneTerminal(items: LoopState["items"]): LoopState["items"] {
  const pruned: LoopState["items"] = {};
  for (const [id, item] of Object.entries(items)) {
    if (item.step === "inbox" || item.step === "resolved" || item.step === "promoted") continue;
    pruned[id] = item;
  }
  return pruned;
}

async function writeStateAndInbox(
  statePath: string,
  inboxPath: string,
  state: LoopState,
  inboxItems: LoopState["items"],
): Promise<LoopState> {
  const newInboxItems: LoopState["items"] = {};
  const remainingItems: LoopState["items"] = {};

  for (const [id, item] of Object.entries(state.items)) {
    if (item.step === "inbox") {
      newInboxItems[id] = item;
    } else {
      remainingItems[id] = item;
    }
  }

  const mergedInbox = { ...inboxItems, ...newInboxItems };
  const prunedItems = pruneTerminal(remainingItems);
  const finalState = { ...state, items: prunedItems };

  await Bun.write(statePath, formatStateMd(finalState));
  await Bun.write(inboxPath, formatInboxMd(mergedInbox));

  return finalState;
}

function buildGeneratorPrompt(item: LoopState["items"][string]): string {
  let note = "";
  if (item.result && "reasons" in item.result) {
    note = `- 上次被拒原因: ${item.result.reasons.join("; ")}`;
  }
  return GENERATOR_PROMPT.replace("{summary}", item.summary)
    .replace("{source}", item.source)
    .replace("{rejectionNote}", note);
}

export async function loopStep(params: LoopStepParams): Promise<LoopState> {
  return withLoopLock(params.loopConfigPath, () => loopStepImpl(params));
}

async function loopStepImpl(params: LoopStepParams): Promise<LoopState> {
  const statePath = `${params.loopConfigPath}/STATE.md`;
  const inboxPath = `${params.loopConfigPath}/INBOX.md`;

  const repoPath = await resolveRepoPath(params.loopConfigPath, params.projectPort, params.dataDir);
  const workDir = repoPath ?? params.loopConfigPath;

  // Construct role-specific skill roots from .loop/skills
  const skillsDir = `${params.loopConfigPath}/skills`;
  const skillRootsByRole = (role: string): SkillRoots => ({
    ws: nodeFsAdapter(skillsDir),
    roots: [role],
    posixSkillRoot: skillsDir,
  });

  // 1. Read files
  let stateMd: string;
  let inboxMd: string;
  try {
    stateMd = await Bun.file(statePath).text();
  } catch {
    stateMd = "";
  }
  try {
    inboxMd = await Bun.file(inboxPath).text();
  } catch {
    inboxMd = "";
  }

  let state = parseStateMd(stateMd);
  const inboxItems = parseInboxMd(inboxMd);

  // Read LOOP.md config (fall back to defaults if missing)
  const loopMdPath = `${params.loopConfigPath}/LOOP.md`;
  let cfg: LoopConfig | null = null;
  try {
    cfg = parseLoopConfig(await Bun.file(loopMdPath).text());
  } catch {
    // no config
  }

  const genModel = cfg?.generator.model ?? GENERATOR_MODEL;
  const evalModel = cfg?.evaluator.model ?? EVALUATOR_MODEL;
  if (genModel === evalModel) {
    throw new Error(`loopStep: generator.model ("${genModel}") must differ from evaluator.model`);
  }
  const genPrompt = cfg?.generator.systemPrompt || GENERATOR_PROMPT;
  const evalPrompt = cfg?.evaluator.systemPrompt || EVALUATOR_PROMPT;
  const acceptance = cfg?.acceptance || ACCEPTANCE;
  const denylist: string[] = (cfg as { denylist?: string[] })?.denylist ?? [];
  const dailyCap = cfg?.budget?.dailyCap ?? 0;

  // 2. Human review action
  if (params.action) {
    const action = params.action;

    if (action.verdict === "retry") {
      const item = inboxItems[action.itemId];
      if (item) {
        state = loopReducer(state, {
          type: "ADD_ITEM",
          item: { id: item.id, source: item.source, summary: item.summary },
          priority: item.priority,
        });
        state = loopReducer(state, { type: "TICK" });
        delete inboxItems[action.itemId];
      }
    } else if (action.verdict === "dismiss") {
      delete inboxItems[action.itemId];
    } else {
      const itemInState = state.items[action.itemId];
      const itemInInbox = inboxItems[action.itemId];
      if (itemInState) {
        state = loopReducer(state, actionToReducer(action));
      } else if (itemInInbox) {
        state = loopReducer(
          {
            ...state,
            items: { ...state.items, [action.itemId]: itemInInbox },
          },
          actionToReducer(action),
        );
      }
    }

    return writeStateAndInbox(statePath, inboxPath, state, inboxItems);
  }

  // 3. Cron TICK — Generator → Evaluator
  state = loopReducer(state, { type: "TICK" });

  const fixingItems = Object.values(state.items).filter((i) => i.step === "fixing");

  // Fail closed: never run git mutations against the backend's own cwd.
  // Only throw when caller explicitly wired projectPort/dataDir but repoPath
  // couldn't be resolved. Tests and legacy callers pass undefined.
  if (fixingItems.length > 0 && !repoPath && (params.projectPort || params.dataDir)) {
    throw new Error(
      "loopStep: cannot process fixing items without a resolved repoPath " +
        "(check LOOP.md projectId, project.repoUrl, and that projectPort/dataDir are wired)",
    );
  }
  const gitCwd = (repoPath ?? ".") as string;

  const budgetKey = `${state.loopId}:${utcDay(Date.now())}`;
  let spent = dailyCap > 0 ? await loadBudget(params.loopConfigPath, budgetKey) : 0;

  for (const item of fixingItems) {
    if (dailyCap > 0 && spent >= dailyCap) break;

    const baseSha = (await Bun.$`git rev-parse HEAD`.cwd(gitCwd).quiet()).text().trim();

    // Generator
    const genSessionId = `loop:${state.loopId}:gen:${item.id}:${item.attempt}`;
    const genSpec = params.buildSpec({
      sessionId: genSessionId,
      modelName: genModel,
      cwd: workDir,
      skillRoots: skillRootsByRole("loop-generator"),
    });

    const genSession = params.sessionFactory.getOrCreate(genSessionId, genSpec);
    await params.sessionFactory.enqueuePrompt(genSessionId, buildGeneratorPrompt(item));
    params.sessionFactory.dispose(genSessionId);
    if (dailyCap > 0) {
      spent = await addBudget(
        params.loopConfigPath,
        budgetKey,
        await tallyUsage(genSpec, genSessionId),
      );
    }

    const headSha = (await Bun.$`git rev-parse HEAD`.cwd(gitCwd).quiet()).text().trim();
    const filesChanged = (
      await Bun.$`git diff --name-only ${baseSha}..${headSha}`.cwd(gitCwd).quiet()
    )
      .text()
      .trim();

    state = loopReducer(state, {
      type: "GENERATOR_DONE",
      itemId: item.id,
    });

    const changedFiles = filesChanged ? filesChanged.split("\n").filter(Boolean) : [];
    const violations = denylistedFiles(changedFiles, denylist);
    if (violations.length > 0) {
      state = loopReducer(state, {
        type: "EVALUATOR_VERDICT",
        itemId: item.id,
        verdict: {
          verdict: "REJECT",
          reasons: [`修改了 denylist 保护路径: ${violations.join(", ")}`],
          evidence: "denylist check (pre-evaluator)",
        },
      });
      await Bun.$`git reset --hard ${baseSha}`.cwd(gitCwd).quiet().nothrow();
      continue;
    }

    // Evaluator
    const evalSessionId = `loop:${state.loopId}:eval:${item.id}:${item.attempt}`;
    const evaluatorPrompt = evalPrompt
      .replace("{acceptance}", acceptance)
      .replace("{filesChanged}", filesChanged || "none");

    const evalSpec = params.buildSpec({
      sessionId: evalSessionId,
      modelName: evalModel,
      cwd: workDir,
      skillRoots: skillRootsByRole("loop-verifier"),
    });

    const verdictPath = `${workDir}/VERDICT.md`;
    try {
      await Bun.write(verdictPath, "");
    } catch {
      // ignore
    }

    const evalSession = params.sessionFactory.getOrCreate(evalSessionId, evalSpec);
    await params.sessionFactory.enqueuePrompt(evalSessionId, evaluatorPrompt);
    params.sessionFactory.dispose(evalSessionId);
    if (dailyCap > 0) {
      spent = await addBudget(
        params.loopConfigPath,
        budgetKey,
        await tallyUsage(evalSpec, evalSessionId),
      );
    }

    // Read verdict
    const verdictMd = await Bun.file(verdictPath)
      .text()
      .catch(() => "");
    let verdict = parseVerdictMd(verdictMd);
    if (!verdictMd.trim()) {
      verdict = { verdict: "ESCALATE", reasons: ["evaluator produced no verdict"], evidence: "" };
    }

    if (verdict) {
      state = loopReducer(state, {
        type: "EVALUATOR_VERDICT",
        itemId: item.id,
        verdict,
      });
    }

    // Rollback on REJECT/ESCALATE
    const updatedItem = state.items[item.id];
    if (updatedItem && (updatedItem.step === "fixing" || updatedItem.step === "inbox")) {
      await Bun.$`git reset --hard ${baseSha}`.cwd(gitCwd).quiet().nothrow();
    }
  }

  // 4. Write back
  return writeStateAndInbox(statePath, inboxPath, state, inboxItems);
}
