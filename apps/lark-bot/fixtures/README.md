# lark-cli NDJSON Fixtures

Captured 2026-06-13 using lark-cli v1.0.53 with Feishu app.

四个 fixture 都被 `src/event-parser.test.ts` 消费。

| Fixture | chat_type | message_type | Bot @mentioned |
|---------|-----------|-------------|----------------|
| `message-p2p.json` | p2p | text | N/A (implicit) |
| `message-group-mention-bot.json` | group | text | Yes (`@小开`) |
| `message-group-no-mention.json` | group | text | No |
| `message-interactive-card.json` | p2p | interactive | N/A |

Bot display name: `小开`

## Key findings

- Output is flat NDJSON (one JSON object per line), not nested
- `mentions[]` array is NOT exposed — mention keys are resolved to `@name` in `.content` by lark-cli's Process hook
- Group @bot detection MUST use `content.includes("@" + botDisplayName)`
- Interactive card `content` is a JSON string (not parsed by lark-cli)
- `event_id` is an opaque string (`evt_p2p001` in these fixtures), not hex
- `senderDisplayName` is an optional nullable field on `larkMessageEventSchema`
  (`packages/api-contract/src/lark.ts`), not part of the ingest pipeline
- `message_id` starts with `om_`, `chat_id` with `oc_`, `sender_id` with `ou_`
