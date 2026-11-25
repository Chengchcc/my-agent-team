# ADR 0080：不可逆的工作带着风险字段，批准权属于人

- 状态: Implemented
- 日期: 2026-11-24
- 相关: ADR 0047（授权来源）、0049（不可逆需人的本轮授权）、0075（请求归属）、0072（子进程权限门）

## 背景

派单链路上，前台已经把"不可逆"判过一次：`needsHumanAuthority(brief)`（operate + irreversible）要求人本轮授权，否则不派。但**派出去之后**，工人若在执行中停下来要批准，请求的归属由 `requestOwnerOf` 决定——授权是 `dispatch:<前台>`，于是请求归前台，前台可以代答。

审计（2026-11-24）指出：代答链没有风险语义，只有"空证据拒绝"。一个不可逆的操作可以被一个模型批准，而人从未看过它。

## 决定

1. **风险是声明出来的字段，不是从名字猜的**。`agent_run.risk`（JSON，迁移 0069）记录派单方声明的风险；目前唯一的声明点是派单时的 `needsHumanAuthority(brief)`，写入 `{irreversible:true}`。
2. **请求在创建时就带上它**：`createPendingAction` 把 `run.risk.irreversible` 写进 `pending_action.payload.risk`，并把 `owner` 强制为 `user`——归属规则不再能把不可逆请求交给前台。
3. **回答侧按字段拒绝**：`answerRefusal`（`features/agent-run/answer-guard.ts`）在"已处理 / 非本人 / `risk.irreversible`"三种情况下拒绝代理回答，要求升级给人。前端/卡片的审批面因此只会出现在人的待办里。
4. **没有声明就不是不可逆**：没有 `risk` 标记的运行保持原有归属（派单方法台优先）。缺失声明不等于安全通过，只是这条通路尚未声明——这一点写在这里，避免把"没有拒绝"读成"已经批准"。

## 为什么不是工具名名单

按工具名（`git push`、`rm -rf`…）判断会读起来像一个检查，实际什么都没检查：名字可换、可包装、可拼字符串。字段的代价是**声明端必须真的存在**；收益是拒绝路径可以被单测钉住，且将来任何声明方（工作流节点、产品工具）都能复用同一条拒绝规则。

## 追加（同日第二刀）：超冻结授权

冻结的范围本来就写在 run 上（`toolPolicy`：deny/allow 路径 + `denyCommands`）。请求创建时用 `beyondFrozenScope(payload, {toolPolicy})` 与请求的实际动作比对：

- 命令命中 `denyCommands` → 越权；
- 写入路径不在 `allow` 列表内（列表非空时）→ 越权。

越权的请求同样在创建时带 `payload.risk.beyondScope = true` + `reason`，并把 owner 强制为 `user`；`answerRefusal` 以"beyond the scope"拒绝代理回答。**这个检查只拒绝把可见的越权交给代理，本身从不下发任何权限。**

## 验收语义：这个担心不成立（按现状）

原审计把"验收"列进代答的三类语义里，隐含"存在一种验收请求可以让代理回答"。核对当前模型：验收不是请求，而是人对 `requirement` 的 PATCH（`status=done`），且已经绑定证据（`accepted_at/accepted_evidence`）。**没有可供代理回答的验收请求**，因此没有可拒绝的对象。若将来验收变成可被请求的动作（例如"这件算不算完成"变成 ask），就把它当 ask 处理：答案只能是人的，因为它就是验收本身。

## 仍未做

- 请求的 `risk` 目前由派单方声明（不可逆）与创建处计算（越权）；子进程/工具自己声明风险的通道还没有。
- AGP/ACP 的审批请求载荷目前不携带风险；本 ADR 的声明点是派单侧。若将来子进程能声明（例如工具自带 `risk`），只需把它并进 `payload.risk`，拒绝规则不变。
- `agent_run.risk` 目前只由派单写入；人发起的不可逆动作没有声明方，因此不会被这条规则拦——这是已知边界，不是遗漏。
