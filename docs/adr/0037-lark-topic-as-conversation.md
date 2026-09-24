# 话题（topic）= 会话：飞书侧的会话边界由话题决定

> 状态：**Accepted**。三个待定项已拍板，字段取值已实测（见下节）。

## 背景

现状是 **一个飞书聊天 = 一个 backend conversation**（`chat_binding.chat_id → conversation_id`）。后果很具体：同一个私聊里所有问题共用一个上下文，一次试验会污染下一次——实测中模型在下一轮说出「你上次没选，我按最常见的 A 方案执行」，即它把上一轮未答的问题自行结掉了；同一会话里再问同一件事，行为不可预期。

平台事实（2026-09-24 实测核对，非推测）：

- **事件里有话题上下文**：`lark-cli event schema im.message.receive_v1` 会送 `thread_id`（"Thread ID, when present"）、`root_id`（"Root message ID of the reply/thread context"）、`reply_to`（"Parent message ID of the direct reply context"）、`chat_type`（`p2p|group`）。我们的 `larkMessageEventSchema` 这三项**都没声明**，被 zod 丢掉——运行时对「这条消息在不在某个话题里」完全失明。
- **发送侧支持回复进话题**：`lark-cli im +messages-reply` 明确支持 thread replies 与 reply-in-thread，并带 idempotency key；`im +threads-messages-list` 能把消息 id 解析成 `thread_id`。而我们现在的卡片走 `POST /im/v1/messages?receive_id_type=chat_id`（直接发到群），文本走 `lark-cli` 的普通发送，两条路径都不进话题。
- **话题群是群模式之一，且不可转换**：`im +chat-create --chat-mode topic` 建话题群；`im chats update` 的说明明确「Only group IDs with group mode of `group` are supported」且无 `chat_mode` 字段 → **普通群转不成话题群**。现有测试群 `测试oma cli` 是 `chat_mode: group`。
- **p2p 私聊没有「话题群」那种模式，但它接受「话题内回复」**：`reply_in_thread: true` 在私聊里被接受（HTTP 200），且响应直接返回 `thread_id`（`omt_…`）与指回被回复消息的 `root_id`——**话题可以由我们主动创建**，不需要等回复链自然形成。

术语澄清（本 ADR 的 `话题`）：**一次连续对话的边界**，在飞书侧表现为 `thread_id`——话题群里由顶层消息开启（顶层消息自带 `thread_id`），私聊里由「回复机器人的卡片」创建（该回复链随后获得 `thread_id`）。不指普通群里的任意回复串（那不经机器人，不产生会话）。

## 决策

1. **话题是会话的边界**。绑定键从 `chat_id` 改为 `(chat_id, thread_key)`：`thread_key` 取 `thread_id`，缺失时取 `root_id`，再缺失取 `message_id`（顶层消息自成一个话题）。一个 `thread_key` 对应一个 conversation。
2. **顶层消息开新话题 = 开新会话**（群与私聊一致）。「在话题里回复」是唯一的「接着问」动作；也因此不会再出现「上一个问题污染下一个」。
3. **私聊同规则（用户拍板 1a，机制由用户指出）**：回答以**「话题内回复」回复用户那条消息**——`reply_in_thread: true` 这一步本身就是创建话题（实测返回 `thread_id`），话题的根因此是**用户那条消息**，机器人卡片落在话题里。用户之后在这个话题里回复即续接同一会话；在话题外发新消息则是新话题、新会话。
4. **群里的话题内仍然要求 @（用户拍板 2）**。理由是一个群里的一个话题下，其他人可能就在该话题交流，`@` 是「这句是对机器人说的」唯一可靠信号。访问控制（ADR 0034 的群策略 / 发送者白名单 / `require_mention`）继续在 **chat 层**判定；私聊不适用 `require_mention`（私聊本身就是点名）。2026-09-24 复核：**私聊的话题内续接同样不要求 @**（用户明确保留这一现状）——私聊没有「旁枝讨论」这个风险，而在飞书私聊里「在话题里回复」就是续问的唯一动作，要求 @ 会把它废掉。
5. **回答进话题**。机器人发卡片与最终文本时以「回复该话题根消息」的形式发出（卡片走 `/open-apis/im/v1/messages/:root/reply`，文本走 `lark-cli im +messages-reply`），答案与问题同处一个话题。
6. **话题内排队**。一个话题 = 一个 conversation = 一条活跃 Run，话题内后续消息排队（沿用现有 `branch_input_queue`，不新增机制）。
7. **不做存量兼容（用户拍板 3）**：不为历史 `chat_binding` / 老会话做迁移设计。新路由下每条消息都归入某个话题（顶层消息以自身 `message_id` 开新话题），因此 chat 级绑定**退出路由**——它只保留为访问控制面（ADR 0034）与「卡片发到哪个 chat」的载体；老会话保持只读。
8. **机器人自己的消息 id 要能映射回话题**：用户可能回复机器人发出的卡片（`root_id` 指向机器人的消息而非用户原消息），因此需要一份「我们发出的 message_id → 话题」记录；`run_card` 已有 `lark_message_id` / `source_message_id`，复用它而不新建表。

## 卡片粒度与排队态（用户拍板 2026-09-24）

1. **一轮 agent loop = 一张卡片。** 同话题里继续说 = **下一张卡片**，不把新消息并进正在跑的那一轮。实现上端侧发消息时显式带 `mode: "normal"`：分支忙时 `enqueueAndAcquire` **一律排队**（有活跃 run 就 `queued: true`，与 mode 无关），空闲时立刻开新 run——于是每条消息各有自己的 run 与卡片。
2. **前一轮没跑完时，新消息的卡片先画「排队中」。** 排队输入被 `acquireNextRun` 提升成新 run（它会把 `run_id` 回写到排队行），届时**同一张卡片**接管那一轮的流式，不另发新卡。
3. **排队卡片支持「取消」，且只作用于这条排队消息**（`POST /api/conversations/:id/inputs/:inputId/cancel`），正在跑的那一轮不受影响。这正是「取消 steer」的语义：那条消息原本会被并进当前轮，现在它独立排队、可独立撤销。
4. 端侧需要排队消息的句柄：`TriggeredRun` 因此带上 `inputId`（`runId` 为空即「没起 run，在排队」）。交接所需的「这条输入被提升成了哪个 run」由排队行的 `run_id` 提供，端侧**读这条输入自己的状态**（`GET /conversations/:id/inputs/:inputId` → `{status, runId}`）。

   **实现时发现的坑：不能用 pending 列表判断。** 输入被提升后状态走 `pending → delivering → delivered`，会**同样从 pending 列表里消失**——「列表里没有」既可能是被取消，也可能是已经在跑。按缺席判取消，会把一张正在流式回答的卡片标成「已取消」。所以：提升看 `runId`，取消看**显式**的 `status === "cancelled"`，读不到状态时保持等待（卡片本身仍可手动取消）。

## 后果

- **收益**：上下文按话题隔离（一次试验 = 一个话题 = 一个新 conversation）；「接着问」有明确语法；Web 控制台按话题列出会话，每个话题可独立查看。
- **代价**：一个群会产出很多 conversation，会话列表变长；私聊里「回复」成为续接的唯一方式，用户需要知道这个动作（控制面文档与卡片文案要说明）；群里每条消息都要 `@`，比「话题内免 @」多一次动作（这是用户为「不误入旁枝讨论」主动选的）。
- **约束**：话题语义只在**新建的话题群**里成立（普通群不可转），私聊靠回复链模拟。
- **风险**：跨话题并发取决于 dispatch 的并发模型（不同 conversation = 不同 branch，理论可并行），实施前需确认；若实际全局串行，用户会看到「另一个话题在跑时我的消息不开始」。

## 实测结果（2026-09-24，话题群 + 私聊各一条真实事件）

| 场景 | `thread_id` | `root_id` | `reply_to` |
|---|---|---|---|
| 话题群·顶层消息（开新话题） | `omt_19d16adf18cf99df` | — | — |
| 话题群·同一话题内回复 | `omt_19d16adf18cf99df`（与顶层相同） | 顶层那条消息 id | 同 `root_id` |
| 私聊·回复机器人的卡片 | — | **机器人的卡片消息 id** | 同 `root_id` |
| 私聊·该回复之后的下一条 | `omt_19d154c2f20f5c85`（新分配） | 同一条卡片 id | 同 `root_id` |
| 私聊·主动带 `reply_in_thread` 回复用户消息 | `omt_19d16185c44f99df`（**响应里直接返回**） | 用户那条消息 id | 同 `root_id` |

三个结论直接决定实现：

1. **话题群的顶层消息自带 `thread_id`**（等于它自己的话题），因此话题键不需要从 `message_id` 自造 ✓
2. **话题内回复沿用同一个 `thread_id`**，话题归属天然可判 ✓
3. **私聊的回复链先只给 `root_id`，随后才出现 `thread_id`**；而我们必须主动用 `reply_in_thread` 创建话题，否则私聊里根本没有话题。所以路由要「两种键都指向同一会话」，并在拿到 `thread_id` 时（发送响应或后续事件）**补写**这条映射。

因此归一化后的路由规则：

```
key = thread_id ?? root_id ?? 「我们发出的 message_id → conversation」 ?? message_id
命中已有绑定 → 续接该会话；未命中且 key 是 message_id → 新话题、新会话
首次见到新分配的 thread_id（私聊回复链）→ 把该 thread_id 补写为同一会话
```
