import { defineExtension } from '../../kernel/define-extension';
import type { HookHandler } from '../../kernel/define-extension';
import { INPUT_PREFIXES } from '../frontend.tui/input/input-prefixes';

export default () =>
  defineExtension({
    name: 'frontend-capability-hints',
    enforce: 'post',

    apply: () => {
      const transformPrompt: HookHandler = async (...args: unknown[]) => {
        const prompt = args[0] as { system: string; messages: Array<{ role: string; content: string }>; frontend?: string };
        // Only inject for TUI (Lark has no keyboard shortcuts)
        if (prompt.frontend && prompt.frontend !== 'tui') return prompt;

        const hints = INPUT_PREFIXES.map(p => `  ${p.llmDescription}`).join('\n');
        const block = `\n<!-- user-shortcuts\nThe user is interacting through a terminal. The following input prefixes are available:\n${hints}\nThese are user-side conveniences. Do not type them yourself. Suggest them when the user would benefit from a faster path.\n-->\n`;

        return { ...prompt, system: `${prompt.system}${block}` };
      };

      return {
        hooks: {
          transformPrompt: { enforce: 'normal', fn: transformPrompt },
        },
      };
    },
  });
