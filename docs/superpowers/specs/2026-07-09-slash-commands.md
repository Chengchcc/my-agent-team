# Spec: Slash Commands -- 前端命令注册表 + 后端 clear/compact 端点

> 状态：待评审
> 设计约束：`docs/architecture/design-philosophy.md` -- 暴露业务，隐藏机制

## 1. 目标

在 Composer 输入框中支持 `/` 开头的 slash command。用户输入 `/` 时弹出命令提示，选中后执行对应操作，不作为消息发送。使用前端统一注册表，新增命令只需加一行声明。

## 2. 设计原则

- **纯前端注册表**：后端不知道 slash command 的存在。每个命令调的是已有 REST API。
- **声明式注册**：`SlashCommand[]` 数组，Composer 只负责检测/路由/渲染提示，不关心命令实现。
- **读写自然分离**：写命令调 POST/PATCH，读命令调 GET，通过 execute 函数签名体现，不引入 CQRS 类型层。
- **不作为消息发送**：`/` 开头的输入如果匹配到命令，执行命令并清空输入框。不匹配则作为普通消息发送。

## 3. 后端 -- 新增 2 个 REST 端点

### 3.1 POST /api/conversations/:id/clear

清除会话上下文：dispose 所有 agent member 的活跃 session，清除 member session binding（`updateMemberSessionId` 设为 null）。下次发消息时自动新建 session（空白记忆）。

不删除 ledger 消息历史（用户仍可看到之前的对话）。

### 3.2 POST /api/conversations/:id/compact

对所有 agent member 的活跃 session 执行手动压缩（`AgentSession.compact()`）。如果 session 不存在或未初始化，跳过。

返回 `{ ok: true }`。

## 4. 前端 -- 命令注册表

### 4.1 SlashCommand 接口

```typescript
interface SlashCommand {
  command: string;                    // "/clear"
  description: string;                // "Clear conversation context"
  argsHint?: string;                  // "<title>" for /title
  execute: (ctx: CommandContext) => Promise<CommandResult>;
}

interface CommandContext {
  conversationId: string;
  args: string;                       // 命令后的参数文本
  // 前端能力注入
  dispatch: (action: unknown) => void; // reducer dispatch
  refreshSnapshot: () => void;        // 刷新会话快照
  toast: (msg: string, type?: "success" | "error" | "info") => void;
}

type CommandResult = { handled: true; message?: string };
```

### 4.2 注册表

```typescript
// slash-commands.ts
export const slashCommands: SlashCommand[] = [
  {
    command: "/clear",
    description: "Clear agent memory (keep chat history)",
    execute: async (ctx) => {
      await api.clearConversation(ctx.conversationId);
      ctx.refreshSnapshot();
      ctx.toast("Context cleared", "success");
      return { handled: true };
    },
  },
  {
    command: "/compact",
    description: "Summarize old messages to save context",
    execute: async (ctx) => {
      await api.compactConversation(ctx.conversationId);
      ctx.toast("Compacted", "success");
      return { handled: true };
    },
  },
  {
    command: "/stop",
    description: "Stop the running agent",
    execute: async (ctx) => {
      // 需要从 canvas 传入当前 spanId
      ...
    },
  },
  // ...其他命令
];
```

### 4.3 命令列表

| 命令 | 类型 | API | 说明 |
|------|------|-----|------|
| `/clear` | 写 | POST /api/conversations/:id/clear | 清除 agent 记忆 |
| `/compact` | 写 | POST /api/conversations/:id/compact | 压缩上下文 |
| `/stop` | 写 | POST /api/ops/runs/:spanId/cancel | 停止运行 |
| `/title <text>` | 写 | PATCH /api/conversations/:id (title) | 设置标题 |
| `/export` | 读 | GET /api/conversations/:id/export | 导出 markdown |
| `/search <keyword>` | 读 | GET /api/conversations/search?q= | 搜索（跳转结果） |
| `/auto` | 前端 | dispatch toggleTriggerMode | 切换触发模式 |
| `/add <@agent>` | 写 | POST /api/conversations/:id/members | 添加成员 |
| `/help` | 读 | 纯前端 | 显示命令列表 |

### 4.4 Composer 集成

1. `handleInput`：检测 `/` 开头，弹出命令提示 popover（复用 @mention popover 模式）
2. 提示列表：过滤匹配的命令，显示 command + description
3. 选中或 Tab 补全：填入命令名，光标留在参数位置
4. `handleSend`：如果输入匹配已注册命令，调 `execute(ctx)`，不调 `onSend`。否则正常发送。
5. 带参数命令：`/title My New Title` -> args = "My New Title"

## 5. 不做的事

- 不做后端命令注册表（slash command 是 UI 机制）
- 不做 CQRS 类型层（读写通过 execute 签名自然分离）
- 不做命令权限控制（复用已有 auth）
- 不做命令历史
- 不做命令别名（`/h` -> `/help`）

## 6. 验收标准

1. 输入 `/` 时弹出命令提示列表
2. 选中命令后执行对应操作，输入框清空
3. `/clear` 清除 agent 记忆（新消息 agent 不记得之前）
4. `/compact` 触发压缩
5. `/stop` 停止运行
6. `/title <text>` 设置标题
7. `/export` 下载 markdown
8. `/help` 显示命令列表
9. 不匹配的 `/xxx` 作为普通消息发送
10. typecheck + test + lint 全绿
