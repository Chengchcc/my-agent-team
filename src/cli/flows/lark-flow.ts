import type { Prompts } from '../prompts/prompt-runner'
import chalk from 'chalk'
import type { LarkAgentConfig } from '../../application/contracts/agent-record'

export interface LarkFlowOptions {
  initial?: LarkAgentConfig | null
  smokeCheck: 'always' | 'ask' | 'never'
}

export interface LarkFlowResult {
  config: LarkAgentConfig
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/
const MAX_SECRET_HINT_LEN = 30

/* eslint-disable no-console -- CLI interactive flow output */
export async function runLarkFlow(prompts: Prompts, opts: LarkFlowOptions): Promise<LarkFlowResult> {
  const appId = await prompts.text({
    message: 'Lark App ID:',
    defaultValue: opts.initial?.appId,
  })

  console.log(chalk.gray('App Secret 只存环境变量名（如 LARK_APP_SECRET），不存明文。'))
  console.log(chalk.gray('请先在 shell / .env 中 export 该变量为实际 secret 值。'))
  const appSecretEnv = await prompts.text({
    message: 'App Secret 对应的环境变量名：',
    defaultValue: opts.initial?.appSecretEnv ?? 'LARK_APP_SECRET',
    validate: (v) => {
      if (!v) return 'Required'
      if (v.length > MAX_SECRET_HINT_LEN) {
        return `看起来像 secret 明文（>${MAX_SECRET_HINT_LEN} 字符）。请填入环境变量名，不是 secret 值本身。`
      }
      if (!ENV_NAME_RE.test(v)) {
        return '环境变量名应为大写字母+下划线，如 LARK_APP_SECRET'
      }
      return undefined
    },
  })

  const config: LarkAgentConfig = {
    appId: appId,
    appSecretEnv: appSecretEnv,
  }

  return { config }
}
