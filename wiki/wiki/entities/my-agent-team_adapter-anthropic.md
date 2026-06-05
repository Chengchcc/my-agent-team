---
title: "@my-agent-team/adapter-anthropic"
type: entity
created: 2026-06-05
tags: [package, adapter, anthropic]
---

# @my-agent-team/adapter-anthropic

Protocol implementation package. Implements `ChatModel` interface for Anthropic's Messages API. Translates Anthropic SSE events into `AIMessageChunk` stream. Not owned by any layer — sits alongside L1, consumed by Backend or callers who construct model instances for Harness. Delivered in M2.
