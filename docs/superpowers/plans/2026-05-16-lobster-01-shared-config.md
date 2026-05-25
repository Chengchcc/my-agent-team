# Lobster Plan 01: Shared & Config

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Shared 基础工具库 + 双层 TOML 配置加载系统 + 协议类型定义, 为后续子系统提供无依赖的基础层

**Architecture:** 纯函数式设计, 无外部依赖, 分层依赖严格单向, shared/ 不能 import 任何其他层, 原子写入保证数据完整性

**Tech Stack:** TypeScript, Zod, Bun, TOML, ULID, JSON Schema

**Depends On:** Master Plan Step 0 完成 (基线稳定)

---

## 文件结构清单

| 文件 | 操作 | 描述 |
|---|---|---|
| `src/shared/ulid.ts` | 新增 | ULID 生成与验证 |
| `src/shared/atomic-write.ts` | 新增 | 原子文件写入工具 |
| `src/shared/logger.ts` | 新增 | 结构化日志工具 |
| `src/shared/errors.ts` | 新增 | 统一错误类与错误码 |
| `src/shared/types/protocol/index.ts` | 新增 | 协议类型导出 |
| `src/config/toml-loader.ts` | 新增 | TOML 双层加载与合并 |
| `src/config/schema.ts` | 新增 | Zod 配置验证 schema |
| `src/config/defaults.ts` | 新增 | 硬编码默认值 |
| `src/config/index.ts` | 新增 | 对外 API |
| `tests/shared/ulid.test.ts` | 新增 | ULID 测试 |
| `tests/shared/atomic-write.test.ts` | 新增 | 原子写入测试 |
| `tests/config/toml-loader.test.ts` | 新增 | TOML 加载测试 |
| `config/global.toml` | 新增 | 全局配置模板 |
| `config/profiles/default.toml` | 新增 | 默认 profile 配置 |

---

## Task 1: ULID 工具

**Files:**
- Create: `src/shared/ulid.ts`
- Test: `tests/shared/ulid.test.ts`

- [ ] **Step 1: Write failing test for ULID generation**

```typescript
// tests/shared/ulid.test.ts
import { describe, it, expect } from 'bun:test';
import { generateULID, isValidULID, ulidTimestamp } from '../../src/shared/ulid';

describe('ULID', () => {
  it('should generate valid ULID', () => {
    const id = generateULID();
    expect(id).toBeString();
    expect(id.length).toBe(26);
    expect(isValidULID(id)).toBe(true);
  });

  it('should validate ULID format', () => {
    expect(isValidULID('01ARZ3NDEK4444444444444444')).toBe(true);
    expect(isValidULID('invalid')).toBe(false);
    expect(isValidULID('')).toBe(false);
    expect(isValidULID('01ARZ3NDEK444444444444444444')).toBe(false); // 27 chars
  });

  it('should extract timestamp', () => {
    const id = generateULID();
    const ts = ulidTimestamp(id);
    expect(ts).toBeNumber();
    expect(ts).toBeGreaterThan(Date.now() - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it('should generate monotonic ULIDs', () => {
    const ids = Array.from({ length: 100 }, () => generateULID());
    // 应该按字典序应该非递减 (同一毫秒内单调)
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] >= ids[i-1]).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/shared/ulid.test.ts -v`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write ULID implementation**

```typescript
// src/shared/ulid.ts

// Crockford's Base32 alphabet (no I, L, O, U)
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = 0;
let lastRandom: number[] = [];

function encodeTime(time: number, length: number): string {
  let str = '';
  for (let i = length - 1; i >= 0; i--) {
    const mod = time % ENCODING_LEN;
    str = ENCODING[mod] + str;
    time = (time - mod) / ENCODING_LEN;
  }
  return str;
}

function encodeRandom(length: number): number[] {
  const random: number[] = [];
  for (let i = 0; i < length; i++) {
    random[i] = Math.floor(Math.random() * ENCODING_LEN);
  }
  return random;
}

function incrementRandom(random: number[]): number[] {
  const newRandom = [...random];
  for (let i = newRandom.length - 1; i >= 0; i--) {
    if (newRandom[i] === ENCODING_LEN - 1) {
      newRandom[i] = 0;
    } else {
      newRandom[i]++;
      break;
    }
  }
  return newRandom;
}

export function generateULID(seedTime?: number): string {
  const time = seedTime ?? Date.now();
  
  if (time < 0 || time > 0xFFFFFFFFFF) {
    throw new Error('Time must be between 0 and 2^40-1');
  }

  let random: number[];
  
  if (time === lastTime) {
    random = incrementRandom(lastRandom);
  } else {
    random = encodeRandom(RANDOM_LEN);
  }

  lastTime = time;
  lastRandom = random;

  const timeStr = encodeTime(time, TIME_LEN);
  const randomStr = random.map(r => ENCODING[r]).join('');

  return timeStr + randomStr;
}

export function isValidULID(id: string): boolean {
  if (typeof id !== 'string' || id.length !== 26) {
    return false;
  }
  return id.split('').every(c => ENCODING.includes(c));
}

export function ulidTimestamp(id: string): number {
  if (!isValidULID(id)) {
    throw new Error('Invalid ULID');
  }
  const timeStr = id.slice(0, TIME_LEN);
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    time = time * ENCODING_LEN + ENCODING.indexOf(timeStr[i]);
  }
  return time;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/shared/ulid.test.ts -v`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/ulid.ts tests/shared/ulid.test.ts
git commit -m "feat: add ULID generation and validation utilities"
```

---

## Task 2: 原子文件写入工具

**Files:**
- Create: `src/shared/atomic-write.ts`
- Test: `tests/shared/atomic-write.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/shared/atomic-write.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { atomicWrite, atomicRead, atomicDelete } from '../../src/shared/atomic-write';
import { unlinkSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'lobster-test-atomic');

describe('atomic-write', () => {
  beforeEach(() => {
    try { unlinkSync(join(TEST_DIR, 'test.txt')); } catch {}
    try { unlinkSync(join(TEST_DIR, 'test.txt.tmp')); } catch {}
  });

  it('should write file atomically', async () => {
    const path = join(TEST_DIR, 'test.txt');
    await atomicWrite(path, 'hello world');
    expect(readFileSync(path, 'utf8')).toBe('hello world');
  });

  it('should read file with fallback', async () => {
    const path = join(TEST_DIR, 'nonexistent.txt');
    const result = await atomicRead(path, 'default');
    expect(result).toBe('default');
    
    await atomicWrite(path, 'content');
    const result2 = await atomicRead(path, 'default');
    expect(result2).toBe('content');
  });

  it('should delete file atomically', async () => {
    const path = join(TEST_DIR, 'test.txt');
    await atomicWrite(path, 'hello');
    expect(existsSync(path)).toBe(true);
    
    await atomicDelete(path);
    expect(existsSync(path)).toBe(false);
  });

  it('should not leave temp file on success', async () => {
    const path = join(TEST_DIR, 'test.txt');
    await atomicWrite(path, 'hello');
    expect(existsSync(path + '.tmp')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/shared/atomic-write.test.ts -v`
Expected: FAIL

- [ ] **Step 3: Write atomic write implementation**

```typescript
// src/shared/atomic-write.ts
import { writeFile, rename, unlink, access, constants } from 'fs/promises';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = filePath + '.tmp';
  const dir = dirname(filePath);
  
  try {
    await access(dir);
  } catch {
    mkdirSync(dir, { recursive: true });
  }

  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}

export async function atomicRead<T>(filePath: string, defaultValue: T): Promise<string | T> {
  try {
    await access(filePath, constants.R_OK);
    return await Bun.file(filePath).text();
  } catch {
    return defaultValue;
  }
}

export async function atomicDelete(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/shared/atomic-write.test.ts -v`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/atomic-write.ts tests/shared/atomic-write.test.ts
git commit -m "feat: add atomic file write/read/delete utilities"
```

---

## Task 3: 统一错误类

**Files:**
- Create: `src/shared/errors.ts`

- [ ] **Step 1: Create error classes**

```typescript
// src/shared/errors.ts

// JSON-RPC 2.0 标准错误码
export enum RpcErrorCode {
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,
  PARSE_ERROR = -32700,
  
  // Lobster 自定义错误码
  SESSION_NOT_FOUND = -32000,
  SESSION_BUSY = -32001,
  PERMISSION_TARGET_MISMATCH = -32002,
  CAPABILITY_NOT_NEGOTIATED = -32003,
  PROFILE_MISMATCH = -32004,
}

export class ProtocolError extends Error {
  public readonly code: number;
  public readonly data?: unknown;

  constructor(code: RpcErrorCode | number, message: string, data?: unknown) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.data = data;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      data: this.data,
    };
  }
}

// 便捷工厂函数
export function invalidRequest(data?: unknown) {
  return new ProtocolError(RpcErrorCode.INVALID_REQUEST, 'Invalid Request', data);
}

export function methodNotFound(method: string) {
  return new ProtocolError(RpcErrorCode.METHOD_NOT_FOUND, `Method not found: ${method}`);
}

export function invalidParams(data?: unknown) {
  return new ProtocolError(RpcErrorCode.INVALID_PARAMS, 'Invalid params', data);
}

export function internalError(data?: unknown) {
  return new ProtocolError(RpcErrorCode.INTERNAL_ERROR, 'Internal error', data);
}

export function sessionNotFound(sessionId: string) {
  return new ProtocolError(RpcErrorCode.SESSION_NOT_FOUND, `Session not found: ${sessionId}`);
}

export function sessionBusy(sessionId: string) {
  return new ProtocolError(RpcErrorCode.SESSION_BUSY, `Session busy: ${sessionId}`);
}

export function permissionTargetMismatch() {
  return new ProtocolError(
    RpcErrorCode.PERMISSION_TARGET_MISMATCH,
    'Permission request target mismatch',
  );
}

export function capabilityNotNegotiated() {
  return new ProtocolError(
    RpcErrorCode.CAPABILITY_NOT_NEGOTIATED,
    'Capability not negotiated, hello required',
  );
}

export function profileMismatch() {
  return new ProtocolError(RpcErrorCode.PROFILE_MISMATCH, 'Profile mismatch');
}
```

- [ ] **Step 2: Verify no syntax errors**

Run: `bun build src/shared/errors.ts --outfile /dev/null`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/shared/errors.ts
git commit -m "feat: add protocol error classes and factory functions"
```

---

## Task 4: 结构化日志

**Files:**
- Create: `src/shared/logger.ts`

- [ ] **Step 1: Create logger implementation**

```typescript
// src/shared/logger.ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  profileId?: string;
  data?: Record<string, unknown>;
}

class Logger {
  private minLevel: LogLevel = 'info';

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }

  private log(level: LogLevel, message: string, profileId?: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(profileId && { profileId }),
      ...(data && { data }),
    };

    // 结构化输出到 stderr (stdout 留给程序输出)
    console.error(JSON.stringify(entry));
  }

  debug(message: string, profileId?: string, data?: Record<string, unknown>): void {
    this.log('debug', message, profileId, data);
  }

  info(message: string, profileId?: string, data?: Record<string, unknown>): void {
    this.log('info', message, profileId, data);
  }

  warn(message: string, profileId?: string, data?: Record<string, unknown>): void {
    this.log('warn', message, profileId, data);
  }

  error(message: string, profileId?: string, error?: Error): void {
    this.log('error', message, profileId, {
      errorMessage: error?.message,
      stack: error?.stack,
    });
  }
}

// 全局单例 logger (仅 shared 层使用, 上层通过依赖注入
export const logger = new Logger();
```

- [ ] **Step 2: Verify no syntax errors**

Run: `bun build src/shared/logger.ts --outfile /dev/null`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/shared/logger.ts
git commit -m "feat: add structured logger with profile tagging"
```

---

## Task 5: Shared 类型导出

**Files:**
- Create: `src/shared/types/protocol/index.ts`
- Create: `src/shared/index.ts`

- [ ] **Step 1: Create protocol types barrel file**

```typescript
// src/shared/types/protocol/index.ts
// 注意: 完整类型由 JSON Schema 生成, 这里先定义基础手动定义基础类型

export type Ulid = string;

export type FrontendId = string;
export type FrontendKind = 'tui' | 'lark-bot' | 'webui';

export type ProfileId = string;

export type SessionState = 'INIT' | 'IDLE' | 'RUNNING' | 'WAITING' | 'CLOSED';

export interface Anchor {
  scope: 'thread' | 'chat' | 'p2p' | 'tui';
  key: string;
}

export interface SessionMeta {
  sessionId: Ulid;
  isMain: boolean;
  title?: string;
  anchor?: Anchor;
  createdAt: string;
  lastActiveAt: string;
  state: SessionState;
  profileId: ProfileId;
}

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  ts?: string;
  toolCallId?: string;
}

export interface Snapshot {
  messages: Message[];
  state: SessionState;
  systemPromptDigest?: string;
  truncated: boolean;
}

export interface Capabilities {
  render?: string[];
  input?: string[];
  events?: string[];
  stream?: {
    cursor?: boolean;
    ringSize?: number;
    snapshotMaxBytes?: number;
    snapshotMessages?: number;
  };
}

export type HealthReport = {
  daemon: 'ok' | 'degraded';
  agentCore: 'ok' | 'degraded';
  sessions: {
    total: number;
    running: number;
    waiting: number;
    idle: number;
  };
  providers: Array<{
    name: string;
    ok: boolean;
    lastErr?: string;
  }>;
  mcp: Array<{
    name: string;
    ok: boolean;
    lastErr?: string;
  }>;
  evolution: {
    running: boolean;
    lastReviewAt?: string;
    cursor?: string;
  };
};
```

- [ ] **Step 2: Create shared index barrel**

```typescript
// src/shared/index.ts
export * from './ulid';
export * from './atomic-write';
export * from './errors';
export * from './logger';
export * from './types/protocol/index';
```

- [ ] **Step 3: Verify builds correctly**

Run: `bun build src/shared/index.ts --outfile /dev/null`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/protocol/index.ts src/shared/index.ts
git commit -m "feat: add shared protocol type definitions and barrel exports"
```

---

## Task 6: Config Zod Schema

**Files:**
- Create: `src/config/schema.ts`

- [ ] **Step 1: Write Zod validation schema**

```typescript
// src/config/schema.ts
import { z } from 'zod';

export const ProviderConfigSchema = z.object({
  name: z.string().default('anthropic'),
  model: z.string().default('claude-sonnet-4-5'),
  max_tokens: z.number().int().positive().default(8192),
});

export const LoggingConfigSchema = z.object({
  path: z.string().default('logs/'),
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export const TraceConfigSchema = z.object({
  retention: z.literal('permanent').default('permanent'),
});

export const McpServerSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

export const McpConfigSchema = z.object({
  servers: z.array(McpServerSchema).default([]),
});

export const EvolutionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  review_interval: z.string().default('30m'),
});

export const LarkBotConfigSchema = z.object({
  app_id: z.string(),
  app_secret_env: z.string(),
  anchor_strategy: z.enum(['thread', 'chat', 'p2p']).default('thread'),
});

export const LarkConfigSchema = z.object({
  bots: z.array(LarkBotConfigSchema).default([]),
});

export const TransportConfigSchema = z.object({
  unix_socket_dir: z.string().default('data/profiles'),
});

export const GlobalConfigSchema = z.object({
  provider: ProviderConfigSchema,
  logging: LoggingConfigSchema,
  trace: TraceConfigSchema,
  mcp: McpConfigSchema,
  evolution: EvolutionConfigSchema,
  lark: LarkConfigSchema,
  transport: TransportConfigSchema,
});

export const ProfileConfigSchema = z.object({
  provider: ProviderConfigSchema.partial().optional(),
  logging: LoggingConfigSchema.partial().optional(),
  lark: LarkConfigSchema.partial().optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type TraceConfig = z.infer<typeof TraceConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type EvolutionConfig = z.infer<typeof EvolutionConfigSchema>;
export type LarkBotConfig = z.infer<typeof LarkBotConfigSchema>;
export type LarkConfig = z.infer<typeof LarkConfigSchema>;
export type TransportConfig = z.infer<typeof TransportConfigSchema>;
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type ProfileConfig = z.infer<typeof ProfileConfigSchema>;

// 合并后的完整配置
export type ResolvedConfig = GlobalConfig & { profileId: string };
```

- [ ] **Step 2: Verify builds correctly**

Run: `bun build src/config/schema.ts --outfile /dev/null`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/config/schema.ts
git commit -m "feat: add Zod config validation schemas"
```

---

## Task 7: Config 硬编码默认值

**Files:**
- Create: `src/config/defaults.ts`

- [ ] **Step 1: Create defaults file**

```typescript
// src/config/defaults.ts
import type { GlobalConfig } from './schema';

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  provider: {
    name: 'anthropic',
    model: 'claude-sonnet-4-5',
    max_tokens: 8192,
  },
  logging: {
    path: 'logs/',
    level: 'info',
  },
  trace: {
    retention: 'permanent',
  },
  mcp: {
    servers: [],
  },
  evolution: {
    enabled: true,
    review_interval: '30m',
  },
  lark: {
    bots: [],
  },
  transport: {
    unix_socket_dir: 'data/profiles',
  },
};

export const DEFAULT_PROFILE_ID = 'default';

// 配置文件路径
export const GLOBAL_CONFIG_PATH = 'config/global.toml';
export const PROFILE_CONFIG_DIR = 'config/profiles';
```

- [ ] **Step 2: Verify builds**

Run: `bun build src/config/defaults.ts --outfile /dev/null`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/config/defaults.ts
git commit -m "feat: add hardcoded config defaults"
```

---

## Task 8: TOML 双层加载器

**Files:**
- Create: `src/config/toml-loader.ts`
- Test: `tests/config/toml-loader.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/config/toml-loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadConfig, getConfigPath, mergeConfigs } from '../../src/config/toml-loader';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_CONFIG_DIR = join(tmpdir(), 'lobster-test-config');

describe('toml-loader', () => {
  beforeEach(() => {
    rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_CONFIG_DIR, 'profiles'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  it('should merge profile config override global config', () => {
    const global = {
      provider: { name: 'anthropic', model: 'sonnet', max_tokens: 8192 },
    };
    const profile = {
      provider: { model: 'opus', max_tokens: 16000 },
    };
    const merged = mergeConfigs(global, profile);
    expect(merged.provider.name).toBe('anthropic');
    expect(merged.provider.model).toBe('opus');
    expect(merged.provider.max_tokens).toBe(16000);
  });

  it('should load global config only when no profile exists', () => {
    const globalToml = `
[provider]
name = "anthropic"
model = "claude-sonnet-4-5"
max_tokens = 8192
`;
    writeFileSync(join(TEST_CONFIG_DIR, 'global.toml'), globalToml, 'utf8');
    
    const config = loadConfig('default', TEST_CONFIG_DIR, TEST_CONFIG_DIR);
    expect(config.provider.name).toBe('anthropic');
    expect(config.provider.model).toBe('claude-sonnet-4-5');
  });

  it('should override with profile config', () => {
    const globalToml = `
[provider]
name = "anthropic"
model = "sonnet"
max_tokens = 8192
`;
    const profileToml = `
[provider]
model = "opus"
max_tokens = 16000
`;
    writeFileSync(join(TEST_CONFIG_DIR, 'global.toml'), globalToml, 'utf8');
    writeFileSync(join(TEST_CONFIG_DIR, 'profiles', 'work.toml'), profileToml, 'utf8');
    
    const config = loadConfig('work', TEST_CONFIG_DIR, TEST_CONFIG_DIR);
    expect(config.provider.name).toBe('anthropic');
    expect(config.provider.model).toBe('opus');
    expect(config.provider.max_tokens).toBe(16000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config/toml-loader.test.ts -v`
Expected: FAIL

- [ ] **Step 3: Implement TOML loader**

```typescript
// src/config/toml-loader.ts
import { parse } from 'smol-toml';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { GlobalConfigSchema, ProfileConfigSchema, type ResolvedConfig, type GlobalConfig, type ProfileConfig } from './schema';
import { DEFAULT_GLOBAL_CONFIG, GLOBAL_CONFIG_PATH, PROFILE_CONFIG_DIR } from './defaults';
import { logger } from '../shared/logger';

// 深度合并配置, profile 覆盖 global
export function mergeConfigs(global: GlobalConfig, profile: ProfileConfig): GlobalConfig {
  const result = { ...global };
  
  if (profile.provider) {
    result.provider = { ...result.provider, ...profile.provider };
  }
  if (profile.logging) {
    result.logging = { ...result.logging, ...profile.logging };
  }
  if (profile.lark) {
    result.lark = { ...result.lark, ...profile.lark };
  }
  
  return result;
}

function loadTomlFile<T>(filePath: string, schema: z.ZodSchema<T>, defaultValue: T): T {
  if (!existsSync(filePath)) {
    return defaultValue;
  }
  
  try {
    const content = readFileSync(filePath, 'utf8');
    const parsed = parse(content);
    const result = schema.safeParse(parsed);
    
    if (result.success) {
      return result.data;
    }
    
    logger.warn(`Config file ${filePath} validation failed, using defaults`, undefined, {
      issues: result.error.issues,
    });
    return defaultValue;
  } catch (err) {
    logger.error(`Failed to load config ${filePath}`, undefined, err as Error);
    return defaultValue;
  }
}

export function loadConfig(
  profileId: string,
  globalConfigDir: string = process.cwd(),
  profileConfigDir: string = process.cwd(),
): ResolvedConfig {
  // 1. 加载全局配置
  const globalPath = join(globalConfigDir, GLOBAL_CONFIG_PATH);
  const globalConfig = loadTomlFile(globalPath, GlobalConfigSchema, DEFAULT_GLOBAL_CONFIG);
  
  // 2. 加载 profile 配置 (可选)
  const profilePath = join(profileConfigDir, PROFILE_CONFIG_DIR, `${profileId}.toml`);
  const profileConfig = loadTomlFile(profilePath, ProfileConfigSchema, {});
  
  // 3. 合并配置
  const merged = mergeConfigs(globalConfig, profileConfig);
  
  // 4. 验证最终配置
  const validated = GlobalConfigSchema.parse(merged);
  
  logger.info(`Loaded config for profile: ${profileId}`);
  
  return {
    ...validated,
    profileId,
  };
}

export function getConfigPath(profileId: string): string {
  return join(PROFILE_CONFIG_DIR, `${profileId}.toml`);
}
```

- [ ] **Step 4: Fix import - add Zod import**

Update the imports in toml-loader.ts to include `z` from Zod:

```typescript
import { z } from 'zod';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/config/toml-loader.test.ts -v`
Expected: All 3 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/config/toml-loader.ts tests/config/toml-loader.test.ts
git commit -m "feat: add TOML config loader with two-layer merge"
```

---

## Task 9: Config 对外 API

**Files:**
- Create: `src/config/index.ts`

- [ ] **Step 1: Create config barrel export**

```typescript
// src/config/index.ts
export { loadConfig, getConfigPath, mergeConfigs } from './toml-loader';
export {
  GlobalConfigSchema,
  ProfileConfigSchema,
  type ResolvedConfig,
  type ProviderConfig,
  type LoggingConfig,
  type McpConfig,
  type EvolutionConfig,
  type LarkConfig,
} from './schema';
export { DEFAULT_GLOBAL_CONFIG, DEFAULT_PROFILE_ID } from './defaults';

// 便捷函数
let _globalConfig: ResolvedConfig | null = null;

export function getSettings(profileId: string = 'default'): ResolvedConfig {
  if (!_globalConfig || _globalConfig.profileId !== profileId) {
    _globalConfig = loadConfig(profileId);
  }
  return _globalConfig;
}

export function reloadSettings(profileId: string = 'default'): ResolvedConfig {
  _globalConfig = null;
  return getSettings(profileId);
}
```

- [ ] **Step 2: Fix typo - remove the extra underscore**

Change `_globalConfig:` to `let _globalConfig:`

- [ ] **Step 3: Verify builds**

Run: `bun build src/config/index.ts --outfile /dev/null`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/config/index.ts
git commit -m "feat: add config public API with caching"
```

---

## Task 10: 配置模板文件

**Files:**
- Create: `config/global.toml`
- Create: `config/profiles/default.toml`

- [ ] **Step 1: Create global config template**

```toml
# config/global.toml
# Lobster 全局配置文件

[provider]
name = "anthropic"
model = "claude-sonnet-4-5"
max_tokens = 8192

[logging]
path = "logs/"
level = "info"

[trace]
retention = "permanent"

[mcp]
servers = []

[evolution]
enabled = true
review_interval = "30m"

[lark]
bots = []

[transport]
unix_socket_dir = "data/profiles"
```

- [ ] **Step 2: Create default profile config**

```toml
# config/profiles/default.toml
# Default profile configuration - 覆盖 global.toml 中的配置

# 可以在这里覆盖 provider 配置
# [provider]
# model = "claude-opus"
# max_tokens = 16000

# 可以在这里配置 Lark Bot
# [[lark.bots]]
# app_id = "cli_your_app_id"
# app_secret_env = "LARK_BOT_SECRET"
# anchor_strategy = "thread"
```

- [ ] **Step 3: Commit**

```bash
mkdir -p config/profiles
git add config/global.toml config/profiles/default.toml
git commit -m "feat: add global and default profile config templates"
```

---

## Task 11: 完整验收测试

- [ ] **Step 1: Run all shared/config tests**

Run: `bun test tests/shared/ tests/config/ -v`
Expected: All tests PASS

- [ ] **Step 2: Run architecture check**

Run: `bun run check:arch`
Expected: No violations (new files should follow constitution)

- [ ] **Step 3: Run type check**

Run: `bun run check:guard`
Expected: No TypeScript errors

- [ ] **Step 4: Run full CI check**

Run: `bun run check:all`
Expected: All checks PASS

- [ ] **Step 5: Commit verification**

```bash
git status
# 确认所有新增文件已提交, 工作区干净
```

---

## Plan 01 完成验收标准

- [ ] 所有 11 个任务全部完成
- [ ] `bun run check:all` 全绿
- [ ] 所有测试通过
- [ ] 配置加载工作正常
- [ ] 无架构违例
