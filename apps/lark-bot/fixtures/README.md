# lark-cli NDJSON Fixtures

Captured 2026-06-13 using lark-cli v1.0.53 with Feishu app.

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
- `event_id` is hex (32 chars), `message_id` starts with `om_`, `chat_id` starts with `oc_`, `sender_id` starts with `ou_`
- No `senderDisplayName` field in the flattened output — use `sender_id` as fallback
