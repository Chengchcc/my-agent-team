# Lobster Spec 01: Shared & Config

**版本**: v1.0  
**对应 PRD**: §7 配置模型, §16 全局不变量, 附录E JSON Schema  
**依赖**: 无  

---

## 1. 需求概述

实现配置的双层 TOML 加载机制，建立协议 schema 的 TypeScript 类型生成管道，提供无外部依赖的基础工具库。

---

## 2. 模块范围

```
src/
├── config/
│   ├── toml-loader.ts      # TOML 双层加载与合并
│   ├── schema.ts           # Zod 运行时验证
│   ├── defaults.ts         # 硬编码默认值
│   └── index.ts            # 对外 API
└── shared/
    ├── ulid.ts             # ULID 生成与验证
    ├── atomic-write.ts     # 原子文件写入
    ├── errors.ts           # 统一错误类
    ├── logger.ts           # 结构化日志
    └── types/protocol/     # JSON Schema → TS 自动生成
        ├── common.ts
        ├── envelope.ts
        ├── jsonrpc.ts
        ├── control-plane.ts
        └── data-plane.ts

docs/architecture/schema/  # 附录E schema 文件落地
```

---

## 3. 详细设计

### 3.1 TOML 双层配置

**加载优先级**: `profile.toml` > `global.toml` > 硬编码 defaults

**字段分组** (PRD §7):

```toml
# config/global.toml
[provider]
name = "anthropic"
model = "claude-sonnet-4-5"
max_tokens = 8192

[logging]
path = "logs/"
level = "info"

[trace]
retention = "permanent"

[transport]
unix_socket_dir = "data/profiles"

[evolution]
enabled = true
review_interval = "30m"
```

```toml
# config/profiles/work.toml
[provider]
model = "claude-opus-4"
max_tokens = 16000

[lark]
[[lark.bots]]
app_id = "cli_xxxx"
app_secret_env = "LARK_WORK_SECRET"
anchor_strategy = "thread"
```

**API 设计**:
```ts
// src/config/index.ts
export function loadConfig(profileId: string): ResolvedConfig
export function getConfigPath(profileId: string): string
```

### 3.2 Schema 类型生成

**落地文件** (`docs/architecture/schema/`):
- `common.schema.json` - Ulid, Iso8601, FrontendId, SessionMeta, Snapshot, Capabilities, HealthReport
- `envelope.schema.json` - {kind:'rpc'/'event'} 信封
- `jsonrpc.schema.json` - JSON-RPC 2.0 消息格式
- `control-plane/*.schema.json` - 23 个 method 的 params/result
- `data-plane/event.schema.json` - 16 种事件 discriminated union

**生成命令** (package.json):
```json
{
  "scripts": {
    "gen:types": "json-schema-to-typescript docs/architecture/schema/**/*.json -o src/shared/types/protocol/"
  }
}
```

### 3.3 Shared 工具

**ULID**:
- 全局 ID 生成，替代现有 UUID
- 支持时间戳提取、单调递增保证

**原子写入**:
- 现有 session store 的 .tmp + rename 逻辑抽离
- 统一 `atomicWrite(path, content)` API

**错误类**:
```ts
export class ProtocolError extends Error {
  code: number // JSON-RPC 错误码 -32600 ~ -32004
  data?: unknown
}
```

**日志**:
- `debugLog` 增强，携带 profileId tag
- 结构化输出，支持后续 ELK 接入

---

## 4. 验收标准

- [ ] `loadConfig('work')` 返回正确合并的配置
- [ ] 非法 TOML 配置启动时报错并退出
- [ ] `bun gen:types` 生成完整的协议类型
- [ ] 所有 `shared/` 模块的外部依赖数 = 0（ESLint 强制）
- [ ] ULID 单调性单元测试通过
- [ ] `atomicWrite` 并发写入测试不丢数据

---

## 5. 不变量

- GI-6: profile 物理隔离，配置路径不可跨出 profile 目录
- P-I6: schema 字段只增不减，新字段必须可选
