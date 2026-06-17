import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Message, MessageSchema } from "@my-agent-team/message";
import type { CheckpointEvent, Checkpointer, InterruptState } from "../checkpointer.js";

const VALID_ID = /^(?!\.)[A-Za-z0-9_\-.]{1,128}$/;

function assertId(id: string): void {
  if (!VALID_ID.test(id) || /^\.+$/.test(id)) {
    throw new Error(`Invalid threadId: ${JSON.stringify(id)}`);
  }
}

async function atomicWriteJSON(target: string, data: unknown): Promise<void> {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export function fileCheckpointer({ dir }: { dir: string }): Checkpointer {
  const ready = mkdir(dir, { recursive: true });

  const path = (id: string, suffix: string) => {
    assertId(id);
    return join(dir, `${id}${suffix}`);
  };

  return {
    async save(id, messages) {
      await ready;
      await atomicWriteJSON(path(id, ".state.json"), messages);
    },
    async load(id) {
      await ready;
      try {
        const buf = await readFile(path(id, ".state.json"), "utf8");
        return MessageSchema.array().parse(JSON.parse(buf)) as Message[];
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async saveInterrupt(id, state) {
      await ready;
      await atomicWriteJSON(path(id, ".interrupt.json"), state);
    },
    async consumeInterrupt(id) {
      await ready;
      const p = path(id, ".interrupt.json");
      try {
        const buf = await readFile(p, "utf8");
        await rm(p);
        return JSON.parse(buf) as InterruptState;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async appendEvent(id, event) {
      await ready;
      await appendFile(path(id, ".events.jsonl"), `${JSON.stringify(event)}\n`);
    },
    async *readEvents(id) {
      await ready;
      try {
        const buf = await readFile(path(id, ".events.jsonl"), "utf8");
        for (const line of buf.split("\n")) {
          if (line) yield JSON.parse(line) as CheckpointEvent;
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
    },
  };
}
