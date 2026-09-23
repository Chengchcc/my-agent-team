# 产品定位四边界：backend 是控制平面，oma 是工作区执行器

项目长期容易被理解成「一个 oma Agent 加了 Web 和飞书入口」。2026-09-23 定位收敛为：backend = OpenClaw 风格 Agent 控制平面，oma = Claude Code 风格工作区执行器，Web = 完整控制台，Lark = 低延迟远程控制与协作端。这不是包装语，是后续架构取舍的判断边界：一句话——backend 管「这件事有没有被做完、谁能接管、结果能不能追」，oma 管「在这个工作区里怎么把事做完」。

## 决策

1. **backend 的价值是控制面事实，不是执行能力。** 它拥有：用户把什么任务交给了哪个 Agent、任务在哪里执行、排队/运行/失败/等待人处理的状态、多端（Web/Lark）继续控制同一个 Run、Agent 改了什么测了什么产物在哪、哪些状态必须可恢复、runtime 从 oma 换成 claude/pi/omp 后产品行为是否不变。启动子进程只是最底层能力；backend 不做更深的 agent loop。
2. **oma 不感知任何 surface。** 它不知道飞书卡片、群聊、设备、卡片回调；只产出执行事件（text_delta / tool 事件 / approval_request / ask_requested / 终态），呈现语义归 backend 与各端。oma 必须能脱离 backend 独立在 workspace 里完成任务。
3. **各端只与 backend 说话。** 端写输入、读 Conversation 与 Run，从不直接写 agent 结果；端与 oma 互不感知。Conversation / Run / canonical Message 分层是这条边界的载体，不可绕过。
4. **顶层目录不改名。** `apps/backend`、`apps/oh-my-agent`、`apps/lark-bot`、`apps/web` 保持技术命名：OpenClaw / Claude Code 是产品风格类比与外部产品名，不是目录职责；oma 是自研 runtime 品牌。品牌化重命名只在产品正式改名（包名、CLI、文档、部署名同步换）时才值得做。

## 后果

- 新功能的归属判断标准：**跨端、可恢复、要审计的事实归 backend；投递与渲染机制归端本地。**「backend 是普通 HTTP 服务」「Lark 是终态文本转发器」的扩展方向被显式否决。
- 分层细节由既有 ADR 承载：运行态/产品态真理见 0019，conversation 投影见 0021，workspace 见 0020；本 ADR 只钉定位与归属判断。
