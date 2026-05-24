# Budget Guard Spec — 工具输出上限 + Wave 边界反应式 Compact

> **Status**: Draft (design-only, no code)
> **Owner**: TBA
> **Tracks**: `tool.outputCap` 契约、`runTurnUsecase` wave 边界 reactive compact、TUI Footer 刻度线升级
> **Cross-refs**: 复用 [tool-wave-spec.md](./2026-05-24-tool-wave-design.md) 的 wave 边界;[sub-agent-spec.md](./2026-05-24-sub-agent-design.md) 中 sub session 禁用本机制(D-3);[plan-mode-spec.md](./2026-05-24-plan-mode-design.md) 不冲突

---

## 0. 目标与非目标

### 0.1 目标
1. **修复 README 承诺过、重构丢失的 token budget 能力**,但**只做最小够用集**。
2. 为内置工具加 `outputCap` 契约:输出超阈值由工具自行 truncate,末尾标注 `<truncated bytes=N/>`。
3. 在 **tool wave 边界** 触发反应式 compact(单档,阈值 0.75),复用现有 `compactSessionUsecase`。
4. Compact 失败时 **抛错到 turn**,不静默 truncate 上下文 —— 用户必须看到。
5. TUI Footer 加 0.75 / 0.90 两道刻度线 + 颜色三档(白/黄/红),帮用户视觉预判。

### 0.2 非目标(故意不做)
- ❌ **5 档 compaction**(README 瞎写的:snip/auto-compact/emergency-truncate/collapse)。emergency/collapse 是静默破坏上下文,产品体验最坏 → 删。
- ❌ **Predictive per-tool token 估算**。`bash`/`web_fetch` 输出量靠猜,MCP 完全不可控;精度差、维护贵。能被 `outputCap` + reactive 完全替代。
- ❌ **细粒度 compaction 策略**(按 turn 类型、按 tool 类型差异化裁剪)。MVP 一刀切。
- ❌ **持久化 budget 状态**。每 turn 重算,不存。
- ❌ **跨 session budget 池**(全局配额)。
- ❌ **`budgetGuard` 配置树**(`defaults.ts` 里的死代码)整体删除,改为新 `budget` 节。

---

## 1. 概念模型

> Budget guard 由 **两道防线 + 一道失败开关** 构成:
> 1. **工具层 outputCap**:防单点爆(单工具输出超大)
> 2. **wave 边界 reactive compact**:防累积爆(history 总量超阈值)
> 3. **compact 失败抛错**:不静默丢上下文

### 1.1 阈值定义(单一来源)

```ts
const BUDGET = {
  compactRatio:    0.75,   // history / tokenLimit 超过则触发 compact
  warnRatio:       0.70,   // TUI 黄色提示
  dangerRatio:     0.90,   // TUI 红色提示(无 emergency 动作,仅视觉)
}
```

> 仅 `compactRatio` 触发副作用,其余仅 UI。

### 1.2 OutputCap 工具矩阵

| 工具 | `outputCap` | 截断行为 |
|---|---|---|
| `bash` | 100 KB | 工具内部检测 stdout+stderr 长度,超限 → 截至上限 + 追加 `\n<truncated bytes=N exit=0/>` |
| `read` | 100 KB | 同上(并复用现有 `maxLines` 参数) |
| `text_editor` view | 100 KB | 同 read |
| `grep` | 50 KB | 超限 → 截 + `\n<truncated matches=N/>` |
| `glob` / `ls` | 50 KB | 同 grep |
| `web_fetch` | 200 KB | 已有 max_length 参数,统一为 outputCap |
| `web_search` | 50 KB | 摘要 + 链接列表,默认不会超 |
| MCP 工具(默认) | 50 KB | catalog 层包一层截断中间件 |
| `task`(sub-agent 输出) | 32 KB | finalText 超限截断 + warn |
| `exit_plan_mode` plan 字段 | 32 KB | 已在 plan-mode-spec D-21 定义,此处对齐 |

**原则**:
- `outputCap` 是 **工具的承诺**,工具自负截断;catalog 层不做兜底。
- 截断标记必须可被 LLM 识别(`<truncated …/>` 标签)。
- 截断**不计入失败**,工具仍返回 ok。

---

## 2. 架构分层

| 层 | 新增 / 修改 |
|---|---|
| `application/ports/tool.ts` | **改**:`Tool` 增加可选 `outputCap?: number`(字节数);约定 execute 自行截断 |
| `application/constants/compact.ts` | **改**:新增 `BUDGET_COMPACT_RATIO = 0.75`、`BUDGET_WARN_RATIO = 0.70`、`BUDGET_DANGER_RATIO = 0.90`;**删除** `COMPACT_AUTO_THRESHOLD_TOKENS`(改由 ratio 推导) |
| `application/usecases/run-turn.ts` | **改**:`auto-compact` 触发点从 turn 入口**追加**到每个 wave 完成之后(turn 入口仍保留 1 次,处理 resume 后超量) |
| `application/usecases/compact-session.ts` | **改**:失败时 throw 而非返回 `ok:false`(或保留 `ok:false` + 上层 throw) |
| `domain/turn-runner.ts` | **改**:wave 结束后 emit `wave.completed` 携带 `historyBytesAfter`;让 usecase 层做决策 |
| `application/contracts/` | **新增** `session.budgetExceeded { ratio, action: 'compact' \| 'fail' }`(可选,trace 用) |
| `config/types.ts` | **改**:删除 `budgetGuard` 节(死代码);新增 `budget: { compactRatio, warnRatio, dangerRatio }` |
| `config/defaults.ts` | **改**:同上 |
| `extensions/tools/` | **改**:为 §1.2 表中每个工具实现 outputCap 截断 |
| `extensions/mcp/` | **改**:注入工具时包 outputCap 截断中间件(默认 50KB,可被服务声明覆盖) |
| `extensions/frontend.tui/views/chrome/Footer.tsx` | **改**:加 0.75/0.90 两道刻度线 + 三档颜色 |

---

## 3. 数据契约

### 3.1 `Tool.outputCap`

```ts
interface Tool {
  // ... existing fields
  outputCap?: number          // 字节数;execute 必须自行截断到此上限
}
```

**约定**:
- `outputCap` 缺省 → 无截断(适用于摘要类、保证短输出的工具)。
- 工具截断后,返回的 `content` 字节数 ≤ `outputCap`。
- 截断时**必须**在末尾追加 `<truncated bytes=ORIG total=ORIG_TOTAL/>` 标签;LLM 由此识别。
- catalog 层 **不强校验**(执行时检查会拖慢);改在 lint / test 阶段断言:有 outputCap 声明的工具单测必须包含截断用例。

### 3.2 反应式 compact 触发点

```
runTurnUsecase(turn):
  // 入口:resume 后的超量保险
  if approxBytes(history) / tokenLimit > BUDGET.compactRatio:
    await compactOrFail(...)

  for round in 0..maxRounds:
    resp = await provider.invoke(...)
    if resp.toolCalls.empty: break
    waves = partitionWaves(...)
    for wave in waves:
      await scheduleWave(wave)
      appendToolResultsToHistory(...)
      // ★ wave 边界 reactive check
      if approxBytes(history) / tokenLimit > BUDGET.compactRatio:
        await compactOrFail(sessionId, deps)
        // compact 后下一 wave 的 provider 调用拿到更短的 history
    appendAssistantToHistory(...)
```

### 3.3 `compactOrFail` 语义

```
compactOrFail:
  try once
  if ok: return
  retry once
  if ok: return
  throw BudgetCompactError(reason)   // → turn-runner 接住 → yield 'turn.failed'
```

**失败 → turn.failed** 的明确错误:
```
<budget-error ratio="0.82" reason="summary_failed_twice">
  Context compaction failed. Please /clear or /compact manually.
</budget-error>
```
用户看到清晰提示,自己决定下一步。**绝不**静默 truncate。

---

## 4. TUI Footer 升级

### 4.1 当前
```
ctx:  1.2/180k ( 15%)  out:  0.5k  ○ idle
```
颜色:warnRatio 0.70 → 黄;dangerRatio 0.90 → 红;否则无色。

### 4.2 升级后
```
ctx: ▓▓▓▓▓▓▓░░░░░░░░ 92.3/180k ( 51%)  out: 1.2k  ● streaming
                  ^                ^
                  0.75 compact     0.90 danger
```

- 8 字符进度条 + 2 道刻度线(`│` 字符或反色背景)
- 颜色仍三档(白/黄/红),阈值对齐 BUDGET 配置
- 鼠标 / 键盘无新交互,仅视觉

> 实现复杂度低:Footer 已是字符串拼接,加一段 progress bar render 函数。

---

## 5. Invariants(测试断言)

1. 所有声明 `outputCap` 的工具,其 `execute` 返回 `content.length ≤ outputCap`(单测断言)。
2. 截断的工具输出末尾**必含** `<truncated …/>` 标签。
3. wave 边界 reactive check 触发 → `compactSessionUsecase` 被调用恰好 1 次/wave(防多次重入)。
4. compact 第 1 次失败 → 自动重试 1 次;第 2 次失败 → throw `BudgetCompactError`,turn yield `turn.failed`,事件 payload reason 含 `compact_failed_twice`。
5. compact 成功后,后续 wave 的 `provider.invoke` 拿到的 history bytes < 触发前。
6. `approxBytes(history) / tokenLimit` 在每个 wave 边界单调下降或持平**当且仅当**触发了 compact;否则单调上升。
7. **Sub-agent session 内禁用 reactive compact**(对齐 sub-agent-spec D-3):wave 边界 check 跳过,超量直接 throw。
8. TUI Footer 渲染:`ratio ∈ [0, warnRatio)` 白;`[warnRatio, dangerRatio)` 黄;`[dangerRatio, ∞)` 红。
9. `BUDGET.*` 配置可被用户 config 覆盖,缺省走 defaults。
10. MCP 工具未声明 outputCap → catalog 自动注入 50KB 默认 cap。

---

## 6. 关键决策点(已决)

| ID | 决策 | 选择 | 理由 / 备选 |
|---|---|---|---|
| **D-1** | 档数 | **2 档**(outputCap + reactive compact) | README 5 档过度;emergency/collapse 静默破上下文是反产品 |
| **D-2** | Predictive estimation | **不做** | 精度差、维护贵、MCP 不可控;被 outputCap 完全替代 |
| **D-3** | Compact 失败策略 | **抛错 → turn.failed** | 静默 truncate 用户无感知;让用户明确知情自己处理 |
| **D-4** | Reactive 触发点 | turn 入口 + wave 边界 | 入口防 resume 超量;wave 边界防本 turn 内累积 |
| **D-5** | outputCap 由谁负责执行 | **工具自身** | catalog 兜底成本高;工具最清楚自己输出语义(如截行 vs 截字节) |
| **D-6** | 截断标记格式 | `<truncated bytes=N/>` XML 风格 | 与 sub-agent-spec D-12 错误标记对齐;LLM 识别强 |
| **D-7** | 重试次数 | **1 次**(共 2 次尝试) | 1 次失败可能是瞬时;再失败大概率是 LLM 长拒,无谓重试 |
| **D-8** | 阈值默认 0.75 | 是 | 经验值:compact 本身需消耗几千 token,留 25% 安全垫;过低浪费,过高来不及 |
| **D-9** | 是否区分 input/output cap | **不区分** | 工具截输出即可;input 由 LLM 自己控制 |
| **D-10** | `BUDGET` 配置位置 | `config.context.budget` | 替换原 `context.budgetGuard` 死代码 |
| **D-11** | Sub-agent 是否启用 | **否**(对齐 sub D-3) | sub 短任务到阈值说明 prompt 设计有问题 |
| **D-12** | Plan mode 是否启用 | **是** | plan 阶段对话也会累积 |
| **D-13** | 截断是否触发 warn | 仅日志,不进 dataplane | 频繁触发会噪音;trace 可见即可 |
| **D-14** | TUI progress bar 字符 | `▓░` 实心/空心 | 跨终端兼容性好;比 unicode block 更可靠 |
| **D-15** | 旧 `COMPACT_AUTO_THRESHOLD_TOKENS=80000` 常量 | **删除** | 改由 `tokenLimit * compactRatio` 推导,与 model context window 自动联动 |

---

## 7. Edge cases

1. **`tokenLimit=0`**(模型未上报上下文窗)→ ratio 计算回退到 80k 硬阈值,warn 日志。
2. **wave 内多 call 同时返回大 output**:wave 全部 settle 后才做 1 次 check;不在 call 级别 check(避免抖动)。
3. **Compact 调用本身计入 history**:`compactSessionUsecase` 的 LLM 调用走独立 session,不污染本 turn history(已有行为)。
4. **截断标记被 LLM 引用**:`<truncated …/>` 出现在 assistant 输出时无副作用,只是文本。
5. **outputCap=0** 或负数 → catalog 加载时 throw,启动失败(防配置错)。
6. **同一 wave 触发 compact 后历史指针变**:wave 内 call 已完成,append 时按 sessionId 串行写入;compact 在 append 后才执行 → 无 race。
7. **Compact 后 ratio 仍 > 0.75**(罕见:摘要本身很长)→ 不无限循环;立即 throw `BudgetCompactError(reason: 'compact_insufficient')`。
8. **用户手动 `/compact`** → 走 `compactSessionUsecase` 同入口;无新增逻辑。
9. **MCP 工具自己声明了 outputCap=200KB**:覆盖默认 50KB(声明优先于注入兜底)。
10. **Resume 一个超量 session**:turn 入口 check 触发 compact;若失败,turn.failed,用户被告知。

---

## 8. 当前测试覆盖 & 建议新增

**当前覆盖**:
- `tests/application/usecases/compact-session.test.ts` — 单档 compact 基础流程
- `tests/extensions/frontend.tui/views/chrome/footer.test.tsx` — 当前两色显示

**新增**:

```
tests/extensions/tools/output-cap.test.ts
  bash 100KB 截断 + <truncated/> 标记
  read 100KB 截断
  grep 50KB 截断
  web_fetch 200KB 截断
  MCP 默认 50KB 截断(注入)
  outputCap=0/negative → catalog throw

tests/application/usecases/run-turn-budget.test.ts
  wave 边界 ratio>0.75 → compact 调用 1 次
  连续 2 wave 均超量 → compact 调用 2 次
  compact 第 1 次失败 + 第 2 次成功 → turn 继续
  compact 连续 2 次失败 → turn.failed + budget-error 标记
  sub-agent session 内不触发 reactive compact(直接 throw)
  resume 超量 session → 入口触发 compact

tests/extensions/frontend.tui/views/chrome/footer-budget.test.tsx
  ratio 0.50 → 白色,无刻度高亮
  ratio 0.72 → 黄
  ratio 0.92 → 红
  progress bar 字符正确(▓░)
```

**Given/When/Then 样例(outputCap)**:
> *Given* `bash` 工具 outputCap=100KB,执行 `cat 500KB-file`。
> *When* tool.end yield。
> *Then* `result.content.length === 100KB`,末尾 200 字节包含 `<truncated bytes=512000/>`,tool 仍返回 ok。

**Given/When/Then 样例(reactive compact)**:
> *Given* session history ≈ 140k token,tokenLimit=180k(ratio 0.78),LLM 调用 2 个 readonly tool 各返回 5k。
> *When* wave 完成 → ratio 升到 0.83。
> *Then* 检测到 > 0.75 → `compactSessionUsecase` 调用 1 次 → history 降到 ≈ 50k → 下一 round provider.invoke 使用压缩后 history。

---

## 9. 分期里程碑

| 期 | 范围 | 验收 |
|---|---|---|
| **M1** | `Tool.outputCap` 契约 + 7 个内置工具截断实现 + 截断标记规范 | output-cap.test.ts 全绿 |
| **M2** | `BUDGET` 配置 + wave 边界 reactive compact + compactOrFail + turn.failed 路径 | run-turn-budget.test.ts 全绿 |
| **M3** | TUI Footer progress bar + 三档颜色 + 刻度线 | footer-budget.test.tsx 全绿;dogfood 一周 |
| **M4**(可选) | MCP 工具 outputCap 自动注入中间件 | MCP 注入测试绿 |

---

## 10. 故意 *不* 做的事

- ❌ Emergency truncate / collapse(README 瞎写)。
- ❌ Predictive token estimation。
- ❌ Per-tool 差异化 compact 策略。
- ❌ 跨 session budget 池。
- ❌ Budget 状态持久化。
- ❌ outputCap 的 catalog 层运行时强校验(单测兜)。

---

## 11. 与其他 spec 的协同

- **tool-wave**:复用 wave 边界作为 reactive check 触发点;**强依赖** tool-wave M2 完成。
- **sub-agent**:sub session 内 invariant 7 显式禁用本机制;`task` 工具 outputCap=32KB 与 sub-agent-spec §3.5 finalText 限制一致。
- **plan-mode**:`exit_plan_mode` 的 plan 字段 outputCap=32KB,与 plan-mode-spec D-21 对齐;plan mode 下反应式 compact 仍启用。
- **README 修订**:必须同步删掉 5 档 compaction 那段瞎话,改写为本 spec 的 2 档描述。

---

## 12. DESIGN.md 落点

- **§2.1 `runTurnUsecase`** invariant 改写:wave 完成后做 reactive budget check。
- **§2.6 Budget guard**(新节):落 §1~§4。
- **§4.6 `tools`** 表格:每行加 `outputCap` 列。
- **§4.12 `frontend.tui`** Footer:升级为 progress bar。
- **§9 Known-but-not-implemented**:删除 "5-tier compaction" / "budget bar";保留 "predictive estimation"(标注故意不做)。
- **README**:同步修订 — 5 档段落整体删除,改述 2 档机制 + outputCap 契约。
