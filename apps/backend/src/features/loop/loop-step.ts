import type { LoopAction, LoopState, LoopConfig } from "@my-agent-team/loop";
import {
  formatInboxMd,
  formatStateMd,
  loopReducer,
  parseInboxMd,
  parseStateMd,
  parseVerdictMd,
  parseLoopConfig,
} from "@my-agent-team/loop";
import type { SessionFactory, SessionSpec } from "../span/session-factory.js";

type ReviewAction = {
  itemId: string;
  verdict: "approve" | "reject" | "promote" | "retry" | "dismiss";
  feedback?: string;
};

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
  "reasons: 原因（REJECT/ESCALATE 时必填，逗号分隔）",
  "evidence: 你跑了什么、结果是什么",
  "---",
].join("\n");

const ACCEPTANCE = "被修改的文件相关测试全绿，改动范围合理";
const GENERATOR_MODEL = "claude-sonnet-4";
const EVALUATOR_MODEL = "claude-opus-4";
const LOOP_AGENT_ID = "loop-agent";

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
  const result: LoopState["items"] = {};
  for (const [id, item] of Object.entries(items)) {
    if (item.step !== "resolved" && item.step !== "promoted") {
      result[id] = item;
    }
  }
  return result;
}

async function writeStateAndInbox(
  statePath: string,
  inboxPath: string,
  state: LoopState,
  inboxItems: LoopState["items"],
): Promise<LoopState> {
  // Extract inbox items
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

export async function loopStep(params: {
  loopConfigPath: string;
  sessionFactory: SessionFactory;
  buildSpec: (params: { sessionId: string; modelName: string; cwd: string }) => SessionSpec;
  action?: ReviewAction;
}): Promise<LoopState> {
  const statePath = `${params.loopConfigPath}/STATE.md`;
  const inboxPath = `${params.loopConfigPath}/INBOX.md`;
  const workDir = params.loopConfigPath;

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
  } catch {}

  const genModel = cfg?.generator.model ?? GENERATOR_MODEL;
  const evalModel = cfg?.evaluator.model ?? EVALUATOR_MODEL;
  const genPrompt = cfg?.generator.systemPrompt || GENERATOR_PROMPT;
  const evalPrompt = cfg?.evaluator.systemPrompt || EVALUATOR_PROMPT;
  const acceptance = cfg?.acceptance || ACCEPTANCE;

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

  for (const item of fixingItems) {
    const baseSha = (await Bun.$`git rev-parse HEAD`.quiet()).text().trim();

    // Generator
    const genSessionId = `loop:${state.loopId}:gen:${item.id}:${item.attempt}`;
    const genSpec = params.buildSpec({
      sessionId: genSessionId,
      modelName: genModel,
      cwd: workDir,
    });

    const genSession = params.sessionFactory.getOrCreate(genSessionId, genSpec);
    await params.sessionFactory.enqueuePrompt(genSessionId, buildGeneratorPrompt(item));
    params.sessionFactory.dispose(genSessionId);

    const headSha = (await Bun.$`git rev-parse HEAD`.quiet()).text().trim();
    const filesChanged = (await Bun.$`git diff --name-only ${baseSha}..${headSha}`.quiet())
      .text()
      .trim();

    state = loopReducer(state, {
      type: "GENERATOR_DONE",
      itemId: item.id,
    });

    // Evaluator
    const evalSessionId = `loop:${state.loopId}:eval:${item.id}:${item.attempt}`;
    const evaluatorPrompt = evalPrompt.replace("{acceptance}", acceptance).replace(
      "{filesChanged}",
      filesChanged || "none",
    );

    const evalSpec = params.buildSpec({
      sessionId: evalSessionId,
      modelName: evalModel,
      cwd: workDir,
    });

    const evalSession = params.sessionFactory.getOrCreate(evalSessionId, evalSpec);
    await params.sessionFactory.enqueuePrompt(evalSessionId, evaluatorPrompt);
    params.sessionFactory.dispose(evalSessionId);

    // Read verdict
    const verdictMd = await Bun.file(`${workDir}/VERDICT.md`)
      .text()
      .catch(() => "");
    const verdict = parseVerdictMd(verdictMd);

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
      await Bun.$`git reset --hard ${baseSha}`.quiet();
    }
  }

  // 4. Write back
  return writeStateAndInbox(statePath, inboxPath, state, inboxItems);
}
