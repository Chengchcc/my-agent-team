import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendConfig } from "../config.js";
import { identityTextOf } from "../features/agent/agent-identity.js";
import type { AgentService } from "../features/agent/index.js";
import type { createOmaModelCatalog } from "../features/models/index.js";

/** Seeded identities for the default team (ADR 0074). Only written when no
 *  human-authored SOUL.md exists yet; never overwrites an operator's edit. */
export const SEED_SOULS: Record<string, string> = {
  default: `# Personal Agent

你是一个人长期依赖的私人助理，不是工具箱。

## 你怎么工作

- 你管的是注意力：先弄清对方真正想要什么，再决定「我答 / 我安排 / 我派人」。
- 动手的活交给团队：你负责说清规格、盯住结果、把结论说成人话。
- 你不假装做完。没验证就说没验证，卡住就说卡在哪、需要谁决定。
- 空闲时你整理知识：这个人在意什么、决定过什么、为什么——记进 wiki，标好来源。

## 你的边界

- 你没有写文件和执行命令的能力，这不是缺陷，是分工。
- 你改变不了授权与配置；需要改，就请人来做。`,
  coder: `# Coder

你是一个工程师。你的作品是改动本身和可复现的验证。

## 你怎么工作

- 先读再改：看不懂的代码不猜着改。
- 改完就跑：验证结果贴命令和输出，不用形容词代替证据。
- 报告写「改了什么 / 怎么验证的 / 还有什么风险」，三句话能说完就别写三段。

## 你的边界

- 只在自己的工作区里动手；工作区外的东西只读。
- 需要人拍板的事（不可逆操作、缺信息、规格矛盾）就停下来问，不硬猜。`,
  researcher: `# Researcher

你把「不确定」变成「可判断」。

## 你怎么工作

- 每个结论标来源；区分「资料这么说」和「我认为」。
- 比较方案时先给取舍维度（成本、风险、可逆性），再给倾向，最后说清前提。
- 找不到就说找不到；不用看起来合理的推测填空。

## 你的边界

- 不做实现，也不替人拍板；你的交付是判断依据。`,
};

export interface SeedTeamDeps {
  config: BackendConfig;
  agentSvc: AgentService;
  codingAgentCatalog: ReturnType<typeof createOmaModelCatalog>;
}

/** Seed default Personal Agent, starter workers (Coder / Researcher), their
 *  SOUL.md templates, and the nightly wiki-lint maintenance workflow. */
export async function seedDefaultTeamAndWorkflows(deps: SeedTeamDeps): Promise<void> {
  const { config, agentSvc, codingAgentCatalog } = deps;

  async function seedSoul(agentId: string, soul: string): Promise<void> {
    if (soul === "") return;
    const agent = await agentSvc.getById(agentId);
    mkdirSync(agent.workspacePath, { recursive: true });
    const file = join(agent.workspacePath, "SOUL.md");
    const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (identityTextOf(existing) !== null) return;
    writeFileSync(file, `${soul.trimEnd()}\n`, "utf8");
  }

  async function ensureAgent(
    id: string,
    name: string,
    options: { harness: string; model?: string; description?: string; role?: "worker" },
  ) {
    try {
      await agentSvc.getById(id);
    } catch {
      await agentSvc.create({
        id,
        name,
        harness: options.harness,
        ...(options.model ? { model: options.model } : {}),
        permissionMode: "auto",
        ...(options.description ? { description: options.description } : {}),
        ...(options.role ? { role: options.role } : {}),
      });
    }
  }

  async function defaultSeedModel(): Promise<{ harness: string; model: string }> {
    try {
      const catalog = await codingAgentCatalog.list();
      const first = catalog.models.find((m) => m.available !== false);
      if (first) return { harness: "oma", model: first.id };
    } catch (err) {
      console.warn(
        "[bootstrap] seed model catalog failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return { harness: "oma", model: "" };
  }

  const seed = await defaultSeedModel();
  const markerPath = join(config.dataDir, ".agent-seed.json");
  const seeded = new Set<string>();
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as { seeded?: string[] };
    for (const id of parsed.seeded ?? []) seeded.add(id);
  } catch {
    /* first boot */
  }

  await ensureAgent("default", "Personal Agent", {
    harness: seed.harness,
    ...(seed.model ? { model: seed.model } : {}),
    description: "Personal agent — manages your attention: understands, dispatches, keeps the wiki",
  });
  await seedSoul("default", SEED_SOULS.default ?? "");

  const team = await agentSvc.list();
  const workerNames = new Set(
    team.filter((agent) => agent.config.role === "worker").map((agent) => agent.config.name),
  );
  const members = [
    {
      id: "coder",
      name: "Coder",
      description:
        "读代码、查实现、跑测试、改代码的工程师。有 shell 与文件工具，工作在自己的仓库副本里：" +
        "可以回答「这个项目某功能怎么实现的」「为什么这里会报错」，也能直接改代码并验证。",
    },
    {
      id: "researcher",
      name: "Researcher",
      description:
        "调研与比较：收集外部资料、核对事实、比较多个方案并给出取舍与依据。产出是判断依据，" +
        "不做代码实现。适合「调研/比较/写一份分析」这类需要查证的工作。",
    },
  ];
  for (const member of members) {
    if (workerNames.has(member.name)) continue;
    if (seeded.has(member.id)) continue;
    await ensureAgent(member.id, member.name, {
      harness: seed.harness,
      ...(seed.model ? { model: seed.model } : {}),
      description: member.description,
      role: "worker",
    });
    await seedSoul(member.id, SEED_SOULS[member.id] ?? "");
    seeded.add(member.id);
  }
  seeded.add("default");
  writeFileSync(markerPath, JSON.stringify({ seeded: [...seeded] }, null, 2), "utf8");

  const workflowPath = join(config.dataDir, "workflows", "wiki-lint.workflow.json");
  if (!existsSync(workflowPath)) {
    mkdirSync(join(config.dataDir, "workflows"), { recursive: true });
    writeFileSync(
      workflowPath,
      JSON.stringify(
        {
          version: 1,
          id: "wiki-lint",
          triggers: [{ type: "cron", cron: "0 4 * * *" }],
          meta: {
            name: "Nightly wiki lint",
            description:
              "每天凌晨检查知识库：补来源、补回链、修正悬空的 supersedes；只做维护，不打扰人",
            tags: ["wiki", "maintenance"],
            status: "active",
            owner: "system",
            updatedBy: "seed",
          },
          nodes: [
            { id: "start", type: "start" },
            {
              id: "lint",
              type: "agent",
              ...(seed.model ? { model: seed.model } : {}),
              agentId: "default",
              prompt: [
                "你是这个知识库的维护者。目标不是把 findings 清零，而是让库里的知识保持可信、可查、不互相打架。",
                "",
                '第一步：先用 wiki_read("index.md") 读目录概览，再运行 wiki_lint 取回全部 findings。',
                "",
                "第二步：按下面的清单做检查（Karpathy 的 wiki-lint 纪律），findings 只是入口：",
                "1) 无来源（unsourced）：能在这轮材料或其它页面里找到出处的，用 wiki_patch 补 sources；",
                "   找不到的，把 status 降为 draft，并在正文末尾加一行「来源待补」。",
                "2) 孤儿（orphan）：找语义相关的页面，在它的正文末尾加一条链接指向本页；",
                "   没有相关页面的，把本页的标题挂到最相关父页的列表里。",
                "3) 悬空 supersedes：删掉那条指向不存在页面的条目。",
                "4) 过时（stale）：某页 status=confirmed 但正文与新页面冲突时，不要改结论——",
                "   在两页里各加一行「与 [[另一页]] 的说法不一致，待裁决」，并把较旧的一页降为 draft。",
                "5) 缺失概念页：同一个概念被三个以上页面链接却还没有自己的页面时，建一个 stub（只放定义与来源）。",
                "",
                "第三步：动手规则",
                "- 每处修改前先 wiki_read 拿当前 revision，再带 expected_revision 调 wiki_patch；被拒绝就重读、重合并、重试。",
                "- 只做最小修复：不重写整页，不改变已经确认的结论，不删除内容。",
                "- 不碰 personal/ 下不属于你的页面；不修改 raw/；不创建无来源的页面。",
                "- 冲突永远只标记、不裁决——裁决是人的事。",
                "",
                "最后把总结写成一句话填入输出 JSON 的 summary 字段（检查了几页、改了几处、哪几处留给人类裁决）。",
              ].join("\n"),
              output: [{ key: "summary", type: "string" }],
              outputSchema: {
                type: "object",
                properties: { summary: { type: "string" } },
                required: ["summary"],
              },
              retry: { maxAttempts: 1, intervalMs: 2000 },
            },
            { id: "done", type: "end", status: "success" },
          ],
          edges: [
            { from: "start", to: "lint" },
            { from: "lint", to: "done" },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
  }
}
