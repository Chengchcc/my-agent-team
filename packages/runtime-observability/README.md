# @my-agent-team/runtime-observability

运行时可观测性的薄封装。它在 `@opentelemetry/api` 之上提供一组面向本系统的 tracer、metric sink、配置解析和属性脱敏工具,把 span 名、属性键和指标标签都收敛成受控的枚举,而不是让调用方随手乱填。

## 为什么需要它

直接用裸 OpenTelemetry 有两个问题:一是 span 名和属性键会随处发散,排查时根本对不上;二是很容易把用户消息、工具输入、Lark 的 chat_id/open_id 这类敏感数据顺手写进 span,造成泄露。这个包用类型把这两件事都钉死。

**Span 名是 fixed enum**(`RuntimeSpanName`),只允许这些:`backend.conversation.append`、`backend.run.schedule`、`backend.run.cancel`、`backend.run.recover`、`backend.run.retry`、`backend.eventlog.project`、`runner.daemon.start`、`runner.attempt.run`、`runner.model.call`、`runner.tool.call`、`runner.eventlog.append`、`lark.ingress.message`、`lark.surface.card.send`、`lark.surface.card.update`。属性键同样限定在 `RuntimeSpanAttributes` 里(`agent.id`、`run.id`、`tool.name`、`runner.transport` 等)。

**脱敏是"丢弃 key",不是掩码。** `redactAttributes` 遍历属性,凡是命中敏感键集合(`message.text`、`tool.input`、`lark.chat_id`、`lark.open_id`、`profile.secret`、`api.key`)的条目会被整个跳过——结果里既没有值也没有这个 key,而不是替换成 `***`。tracer 在每次 `startSpan` 写属性前都会先跑一遍这个脱敏。指标侧也有类似的白名单:标签只保留 `agent_id`、`run_kind`、`status`,其余一律丢掉。

## 核心概念

**ObservabilityMode** 有三个真实取值:`off`、`console`、`otlp`。`resolveObservabilityConfig` 负责把它解析出来——优先用显式 override,其次读环境变量 `MIRA_OBSERVABILITY_MODE`,再退化到默认(测试环境 `off`,否则 `console`)。同时它还解析采样率(`MIRA_OTEL_SAMPLE_RATIO`,默认 1.0)和 OTLP endpoint,并把 `redact` 固定为 `"strict"`。

**Tracer。** `createRuntimeTracer(config)` 在 `mode === "off"` 时返回一个 no-op 实现(`startSpan` 直接跑 fn,不建 span);否则用 `trace.getTracer(serviceName)` 包出真 tracer。`startSpan` 会包住异步函数、成功设 OK、抛错时设 ERROR 并 `recordException`,最后 `end()`。另外提供 `inject()`(产出 W3C `traceparent` 形式的 `RuntimeTraceContext`,用于跨进程传播,比如 backend 传给 daemon)和 `link()`(把外来的 trace 上下文挂到当前)。

**Metric sink。** `createRuntimeMetricSink(config)` 同样按 mode 分流:`off` 给 no-op,其余给一个往 console 打点的实现,支持 histogram / counter / gauge 三类,写入前对标签做白名单过滤。

## 怎么用

```ts
import {
  resolveObservabilityConfig,
  createRuntimeTracer,
  createRuntimeMetricSink,
} from "@my-agent-team/runtime-observability";

const config = resolveObservabilityConfig({ serviceName: "runner-daemon" });
const tracer = createRuntimeTracer(config);
const metrics = createRuntimeMetricSink(config);

await tracer.startSpan(
  "runner.model.call",
  { "agent.id": "agent-x", "run.id": "run-1", "tool.input": "secret will be dropped" },
  async () => {
    // ... 实际调用模型
  },
);

metrics.recordCounter("runner_runs_total", 1, { agent_id: "agent-x", status: "succeeded" });

// 跨进程传播:在 backend 侧 inject,随 start 消息发给 daemon
const ctx = tracer.inject(); // { traceId, spanId, traceparent }
```

需要时也可直接调用 `redactAttributes` / `isRedactedKey` 在写日志或上报前手动脱敏。

## 依赖关系

运行时只依赖 `@opentelemetry/api`,刻意保持极薄,以便任何层都能安全引用。被 `@my-agent-team/runner-protocol` 和 `apps/backend` 消费。
