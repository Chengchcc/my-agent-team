# 模型与 Provider

一句话：本页是模型与 provider 的权威描述。`packages/ai` 是唯一的模型层：provider 注册制 + 声明式 model catalog，三个 API 实现（`anthropic-messages` / `openai-completions` / `openai-responses`）自注册，凭证只经 env 进子进程；oma 侧另有一层 `models.yml` 运行时目录，用来覆盖内置目录并声明自定义 provider。

## 范围

覆盖：provider 注册与 API 实现、内置 catalog 与自定义 `models.yml`、`OMA_HOME` 的作用与产品侧为什么只读它、凭证解析顺序、模型别名、thinking 与 reasoning effort 的映射、模型目录的四个来源与 `/api/models` 聚合、生效模型的来源。

不覆盖：Agent Backend 契约与四个 adapter 的 spawn（见 [Agent Backend](../execution/agent-backend.md)）、oma 运行时怎么用模型（见 [Oma Runtime](./oma.md)）、工作区里 `agent.yml` 的模型字段（见 [Agent 工作区与多后端](../agents/workspace-and-backends.md)）。

## 实现文件

- `packages/ai/src/index.ts` — 导出面与 API 实现的自注册副作用导入
- `packages/ai/src/model-runtime.ts` — `createModelRuntime`：provider 注册、目录、`resolveModel`、`stream`
- `packages/ai/src/model-catalog.ts` — `BUILTIN_CATALOG`、`parseCatalogYAML`、`buildModel`、`MODEL_ALIASES`
- `packages/ai/src/{api-registry,compat,types}.ts` — API 注册表、compat 解析、`Model` / `Provider` / `CredentialStore`
- `packages/ai/src/providers/*` — 三个 API 实现与 `createProvider` 工厂
- `apps/oh-my-agent/src/core/runtime/runtime-catalog.ts` — 运行时 `models.yml` 的查找、合并与注册
- `apps/oh-my-agent/src/core/runtime/{model-catalog,model-effort}.ts` — 目录的契约形态、effort 映射
- `apps/backend/src/features/provider/*` — 产品侧的 provider 键管理
- `apps/backend/src/features/models/http.ts` — `GET /api/models`

## Provider 与 API 实现

`createModelRuntime()` 持一张 provider 表（`registerProvider` / `setProvider` / `getProvider`），重复注册同一个 id 直接抛错。模型流按 `(providerId, modelId)` 查表，找不到就报错，不做回落。

API 实现按 `api` 字段分派，三个内置实现分别在模块加载时自注册：

| api | 用途 |
|---|---|
| `anthropic-messages` | Anthropic Messages 协议 |
| `openai-completions` | OpenAI Chat Completions 协议（DeepSeek、Groq、OpenRouter 也走这条） |
| `openai-responses` | OpenAI Responses 协议（o 系列） |

`Api` 类型是开放联合，自定义实现可以注册别的字符串。`Model.compat` 是稀疏的逐 API 兼容开关，例如 OpenAI 侧的 `thinkingFormat`（`none` / `deepseek` / `qwen` / `zai` / `openrouter`）、`maxTokensField`、`supportsReasoningEffort`、`supportsDeveloperRole`；Anthropic 侧有 `forceAdaptiveThinking`、`supportsCacheControlOnTools` 等。

## 内置 catalog

`BUILTIN_CATALOG` 内联在代码里，六个 provider，每个带自己的 `api`、`baseUrl`、`apiKeyEnv`：

| provider | api | apiKeyEnv |
|---|---|---|
| `anthropic` | `anthropic-messages` | `ANTHROPIC_API_KEY` |
| `openai` | `openai-completions` | `OPENAI_API_KEY` |
| `openaiResponses` | `openai-responses` | `OPENAI_API_KEY` |
| `deepseek` | `openai-completions` | `DEEPSEEK_API_KEY` |
| `groq` | `openai-completions` | `GROQ_API_KEY` |
| `openrouter` | `openai-completions` | `OPENROUTER_API_KEY` |

模型的稀疏 spec 只写差异字段，缺省值是：`reasoning: false`、`input: ["text"]`、`contextWindow: 200000`、`maxTokens: 8192`、四项成本全 0。

## models.yml：运行时目录

oma 侧在装配 provider 前先读一份运行时的 `models.yml`，深合并进内置目录（provider 级字段覆盖，模型按 id 覆盖或新增）。文件里能声明内置目录没有的 provider，字段与内置一致：

```yaml
providers:
  example:
    api: openai-completions
    baseUrl: https://example.internal/v1
    apiKeyEnv: EXAMPLE_API_KEY
    apiKey: sk-inline-fallback        # 可选，env 没设时用
    headers: { X-Tenant: acme }       # 可选，自定义请求头
    models:
      - id: example-large
        name: Example Large
        reasoning: true
        contextWindow: 200000
        thinking: { mode: effort, efforts: [off, low, high] }
```

查找顺序（取第一个存在的文件）：

```text
$OMA_HOME/models.yml  →  $HOME/.oma/models.yml  →  <cwd>/.oma/models.yml
```

### OMA_HOME 的作用

`OMA_HOME` 是这个部署的家目录，默认 `~/.oma`。它同时决定 gateway 的安装与数据布局，以及运行时目录里**第一优先级**的那份 `models.yml` 的位置。注意两个名字相近但不同的开关：`OMA_HOME` 管 gateway 与模型目录，oma 自己的 session 文件与插件信任记录用的是 `agentDir()`（`OMA_CODING_AGENT_DIR`，默认也是 `~/.oma`），两者默认同目录但可以分开。

### 产品里为什么只读 $OMA_HOME

产品后端为每个子进程设 `OMA_WORKSPACE_CATALOG=0`。此时运行时目录只允许一个候选：`$OMA_HOME/models.yml`；后两个候选（`$HOME/.oma` 与 cwd）都不加载，`OMA_HOME` 没设时干脆不读任何文件、只用内置目录。

理由是这两处都可被 Agent 触达：cwd 就是 Agent 可写的工作区，`$HOME/.oma` 也能被不受沙箱约束的 bash 写到。一个被改写的 `models.yml` 能改 provider 的 `baseUrl`，把请求与密钥送到攻击者那里。独立 CLI 会话不受这个开关影响，照常按三级顺序找。

## 凭证

provider 注册时就要求有凭证：`registerProvidersFromCatalog` 逐个解析 apiKey，解析不到的 provider **静默跳过**（所以没有密钥的 provider 不会出现在模型目录里）。解析顺序是：

1. `apiKeyEnv` 指定的环境变量；
2. `models.yml` 里内联的 `apiKey`；
3. anthropic 特例：`ANTHROPIC_AUTH_TOKEN`（走代理的用户依赖它）。

`baseUrl` 也有一个特例：`ANTHROPIC_BASE_URL` 覆盖 spec 里的值；解析出来的 URL 末尾如果不是 `/v1` 会自动补上。

产品侧的 provider 键管理（`features/provider/`）只做一件事：把用户填的密钥和 baseUrl 存进 settings，然后以 env 的形式交给 spawn 的子进程。内置五个键（anthropic / openai / deepseek / groq / openrouter）可以按 id 设置；此外还有一组"按名字添加"的自定义键，供 `models.yml` 里声明了 `apiKeyEnv` 的 provider 使用，键名形状约束为 `^[A-Z][A-Z0-9_]*_API_KEY$`。显式添加的键压过同名的内置键。值不回浏览器。

凭证进入模型层后只经 `ProviderAuth` 传给 provider，`CredentialStore`（可选）在每次请求时解析，provider 不缓存。

## 模型目录的四个来源

| kind | 来源 |
|---|---|
| `oma` | 真跑 `oma --list-models`，解析 JSON 目录；结果按实例缓存，provider 环境变化时显式失效 |
| `claude_code` | 包内静态表（claude 没有枚举命令） |
| `pi` | 包内静态表 |
| `omp` | 包内静态表 |

oma 交给产品的目录只含 id、显示名、reasoning、输入模态、上下文窗口、最大输出、可用标记与成本，**不含**凭证、请求头与 provider 对象。

`GET /api/models` 把四个 kind 的目录合成一份，按 provider 前缀分组；每个模型带 `backendKind`，因为同一个 provider/model id 可能在多个 kind 下都存在。成本表在启动时快照一次，按 `kind/别名解析后的模型 id` 建键。

## 模型别名

`MODEL_ALIASES` 是一张旧 id 到规范 id 的桥表（`claude-sonnet-4-6 → claude-sonnet-5`、`gpt-4o → gpt-5.2`、`deepseek-chat → deepseek-v4-flash` 之类）。`resolveModelAlias` 先查直接命中，再尝试剥掉 `<provider>/` 前缀后查一次，命中就把前缀加回去。这张表被产品用两次：成本表建键，以及预检某个模型在当前目录里是否存在。

## thinking 与 reasoning effort

产品侧的枚举只有四档（`none` / `low` / `high` / `max`），定义在契约包里。运行时侧只有一处映射：`reasoningEffortOptions(effort)` 把 `none` 翻成思考关闭，把 `low` / `high` / `max` 翻成自适应思考加对应档位，`max` 在这一层改写成 provider 的 `xhigh`——产品的最顶档与 provider 的最顶档名字不同。

各后端的落地方式不同：

| kind | 落法 |
|---|---|
| `oma` | 经 `ProviderStreamOptions` 传给 provider 实现 |
| `claude_code` | `--effort <档位>`（`none` 不传这个 flag） |
| `omp` | `--thinking <none→off，其余原样>` |
| `pi` | 不传：pi 没有 effort / thinking 开关 |

模型自己的支持范围来自 catalog 的 `thinking` 配置：`efforts` 列出支持的档位，映射成 `thinkingLevelMap`，不支持的档位是 `null`，`clampThinkingLevel` 会把落在空档上的请求降到 `off` 或第一个支持的档位。

## 生效模型的来源

- 一个 Run 用哪个模型，由 Run 创建时冻结的 `model` 引用决定（`backendKind` + `modelId` + 可选 `reasoningEffort`）。Run 中途改模型不影响当前 Run。
- 解析时走一次别名表，然后在目录里按 `<provider>/<model>` 精确匹配；匹配不到是硬错误，绝不静默换一个模型。
- 独立 CLI 的默认模型是目录里第一个可用项；TUI 里换的模型写进 `.oma/settings.json`。

## 不变量

1. 凭证只经 env 与 `ProviderAuth` 流动，不进模型目录、不进事件、不进日志。
2. 没有凭证的 provider 不被注册，因此不出现在任何模型列表里。
3. 三个 API 实现自注册，新增协议不改模型运行时。
4. 自定义 `models.yml` 可以覆盖内置 provider 的 `api` / `baseUrl` / `apiKeyEnv`，产品子进程只允许 `$OMA_HOME` 那一份。
5. 模型解析失败是硬错误，没有回落路径。

## 已知缺口

- `BackendModel.available` 在 oma 侧恒定是 `true`（目录里能出现就说明 provider 已注册），所以这个字段目前不携带信息。
- `claude_code` / `pi` / `omp` 的目录是静态表，与 CLI 实际支持的模型可能脱节。
- `models.yml` 的解析器是极简实现（只支持本文件用到的形状），写复杂 YAML 会静默读不到字段。
- 产品侧只能管密钥与 baseUrl；`api` / `headers` / 模型定义仍然只能写 `models.yml`。

## 相关页

- [Oma Runtime](./oma.md) — 运行时怎么消费模型
- [Agent Backend](../execution/agent-backend.md) — 模型引用怎么过契约边界
- [Agent 工作区与多后端](../agents/workspace-and-backends.md) — `agent.yml` 里的模型字段
