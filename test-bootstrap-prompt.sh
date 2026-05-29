#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

: "${ANTHROPIC_AUTH_TOKEN:?env ANTHROPIC_AUTH_TOKEN required}"

API_URL="${API_URL:-https://ark.cn-beijing.volces.com/api/coding/v1/messages}"
MODEL="${MODEL:-deepseek-v4-pro[1m]}"
USER_MSG="${1:-你好}"
SHOW_THINKING="${SHOW_THINKING:-1}"   # 设为 0 隐藏 thinking

read -r -d '' SYSTEM <<'EOF' || true
## Bootstrap Pending — 身份初始化

**[最高优先级指令]** 本轮你唯一的任务:用一句简短中文向用户提问「role」。
字段含义:你的角色定位(例如:后端工程师、产品经理、研究员)。

规则:
1. 直接输出问题,不要寒暄、不要自我介绍、不要回答用户的其他话题
2. 如果用户上一条消息已经给出了该字段的值,确认并简短复述,不要追问
3. 不要调用任何工具
4. 不要假装 bootstrap 已完成

第 1/6 轮

---

## Available Skills

The following skills are available via the `Skill` tool. Call `Skill(name='<name>')` to load full instructions.

- **skill-creator**: Create new skills, modify and improve existing skills, and measure skill performance.
EOF

PAYLOAD=$(jq -n \
  --arg model   "$MODEL" \
  --arg system  "$SYSTEM" \
  --arg userMsg "$USER_MSG" \
  '{model:$model, max_tokens:256, system:$system, messages:[{role:"user", content:$userMsg}]}')

RESP=$(curl -sS -w '\n%{http_code}' "$API_URL" \
  -H "x-api-key: $ANTHROPIC_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

BODY=$(printf '%s\n' "$RESP" | sed '$d')
CODE=$(printf '%s\n' "$RESP" | tail -n1)

if [[ "$CODE" != "200" ]]; then
  echo "HTTP $CODE" >&2
  echo "$BODY" | jq . >&2 || echo "$BODY" >&2
  exit 1
fi

if [[ "$SHOW_THINKING" == "1" ]]; then
  echo "$BODY" | jq -r '
    (if ([.content[]? | select(.type=="thinking")] | length) > 0
     then "── THINKING ──\n" + ([.content[]? | select(.type=="thinking") | .thinking] | join("\n")) + "\n\n── TEXT ──\n"
     else ""
     end) +
    (([.content[]? | select(.type=="text") | .text] | join("\n")) | if . == "" then "(empty)" else . end)
  '
else
  echo "$BODY" | jq -r '[.content[]? | select(.type=="text") | .text] | join("\n") | if . == "" then "EMPTY" else . end'
fi
