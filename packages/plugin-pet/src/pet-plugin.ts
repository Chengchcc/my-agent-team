import type { ChatModel } from "@my-agent-team/core";
import { definePlugin, type Plugin } from "@my-agent-team/framework";
import type { Message } from "@my-agent-team/message";
import { generateBark, PetBarkKey, shouldBark } from "./bark.js";
import { awardXP, updateMood } from "./state.js";
import { createInitialState, type PetState } from "./types.js";

export interface PetPluginOptions {
  petModel: ChatModel;
  cwd: string;
  enabled?: boolean;
}

export { PetBarkKey } from "./bark.js";
export type { PetBark, PetMood, PetPersistedState, PetState } from "./types.js";

export function petPlugin(opts: PetPluginOptions): Plugin {
  const enabled = opts.enabled ?? false;
  const state: PetState = createInitialState();

  return definePlugin({
    name: "pet",
    hooks: {
      async beforeRun(_ctx, messages: readonly Message[]): Promise<Message[]> {
        if (!enabled) return [...messages];
        state.mood = "neutral";
        state.consecutiveErrors = 0;
        state.lastBarkTurn = 0;
        state.turnCount = 0;
        state.lastReviewedMessageCount = 0;
        state.barkHistory = new Set();
        return [...messages];
      },

      async afterTool(_ctx, _call, result, _messages) {
        if (!enabled) return;
        if (result.is_error) {
          state.consecutiveErrors++;
          if (state.consecutiveErrors >= 3) {
            state.mood = "frustrated";
          }
        } else {
          if (state.consecutiveErrors >= 3) {
            state.mood = "neutral";
          }
          state.consecutiveErrors = 0;
        }
      },

      async afterModel(ctx, messages) {
        if (!enabled) return;

        state.turnCount++;
        state.totalTurns++;

        const leveledUp = awardXP(state);
        updateMood(state);

        if (shouldBark(state)) {
          const bark = await generateBark(opts.petModel, state, messages);
          if (bark) {
            state.totalBarks++;
            state.lastBarkTurn = state.turnCount;
            ctx.context.set(PetBarkKey, {
              mood: state.mood,
              text: bark,
              level: state.level,
              turn: state.turnCount,
            });
            // ponytail: reuse todo_update event as carrier (pet_bark not in union yet)
            void leveledUp;
          }
        }
      },
    },
  });
}
