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
  /** Settings service for persisting pet state across runs. */
  settings?: PetSettingsStore;
}

export interface PetSettingsStore {
  get(key: string, prefix: string): string | undefined;
  getNumber(key: string, prefix: string): number | undefined;
  set(key: string, value: string, prefix: string): void;
}

export { PetBarkKey } from "./bark.js";
export type { PetBark, PetMood, PetPersistedState, PetState } from "./types.js";

const PET_PREFIX = "pet";

function loadState(store: PetSettingsStore | undefined): PetState {
  const s = createInitialState();
  if (!store) return s;
  s.level = store.getNumber("level", PET_PREFIX) ?? 1;
  s.xp = store.getNumber("xp", PET_PREFIX) ?? 0;
  s.totalTurns = store.getNumber("totalTurns", PET_PREFIX) ?? 0;
  s.totalBarks = store.getNumber("totalBarks", PET_PREFIX) ?? 0;
  return s;
}

function saveState(store: PetSettingsStore | undefined, state: PetState): void {
  if (!store) return;
  store.set("level", String(state.level), PET_PREFIX);
  store.set("xp", String(state.xp), PET_PREFIX);
  store.set("totalTurns", String(state.totalTurns), PET_PREFIX);
  store.set("totalBarks", String(state.totalBarks), PET_PREFIX);
}

export function petPlugin(opts: PetPluginOptions): Plugin {
  const enabled = opts.enabled ?? false;
  const state: PetState = loadState(opts.settings);

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

        awardXP(state);
        updateMood(state);

        if (shouldBark(state)) {
          const bark = await generateBark(opts.petModel, state, messages);
          if (bark) {
            state.totalBarks++;
            state.lastBarkTurn = state.turnCount;
            const barkData = {
              mood: state.mood,
              text: bark,
              level: state.level,
              turn: state.turnCount,
            };
            ctx.context.set(PetBarkKey, barkData);
            ctx.emit?.({
              type: "pet_bark",
              payload: barkData,
            });
          }
        }

        saveState(opts.settings, state);
      },
    },
  });
}
