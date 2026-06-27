import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Message, MessageSchema } from "@my-agent-team/message";
import type { CheckpointEvent, Checkpointer, InterruptState } from "../checkpointer.js";

const VALID_ID = /^(?!\.)[A-Za-z0-9_\-.]{1,128}$/;

function assertId(id: string): void {
  if (!VALID_ID.test(id) || /^\.+$/.test(id)) {
    throw new Error(`Invalid sessionId: ${JSON.stringify(id)}`);
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

interface FileEventRow {
  spanId: string | null;
  event: CheckpointEvent;
}

export function fileCheckpointer({ dir }: { dir: string }): Checkpointer {
  const ready = mkdir(dir, { recursive: true });

  const path = (id: string, suffix: string) => {
    assertId(id);
    return join(dir, `${id}${suffix}`);
  };

  return {
    async save(sessionId, messages) {
      await ready;
      await atomicWriteJSON(path(sessionId, ".state.json"), messages);
    },
    async load(sessionId) {
      await ready;
      try {
        const buf = await readFile(path(sessionId, ".state.json"), "utf8");
        return MessageSchema.array().parse(JSON.parse(buf)) as Message[];
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async saveInterrupt(sessionId, state) {
      await ready;
      await atomicWriteJSON(path(sessionId, ".interrupt.json"), state);
    },
    async consumeInterrupt(sessionId) {
      await ready;
      const p = path(sessionId, ".interrupt.json");
      try {
        const buf = await readFile(p, "utf8");
        await rm(p);
        return JSON.parse(buf) as InterruptState;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async appendEvent(sessionId, spanId, event) {
      await ready;
      const row: FileEventRow = { spanId: spanId ?? null, event };
      await appendFile(path(sessionId, ".events.jsonl"), `${JSON.stringify(row)}\n`);
    },
    async *readEvents(sessionId, opts?) {
      await ready;
      try {
        const buf = await readFile(path(sessionId, ".events.jsonl"), "utf8");
        for (const line of buf.split("\n")) {
          if (!line) continue;
          try {
            const row = JSON.parse(line) as FileEventRow;
            if (opts?.spanId && row.spanId !== opts.spanId) continue;
            yield { ...row.event, spanId: row.spanId, ts: row.event.ts };
          } catch {
            /* skip corrupted lines */
          }
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
    },
    async deleteThread(sessionId) {
      await ready;
      await rm(path(sessionId, ".state.json"), { force: true });
      await rm(path(sessionId, ".interrupt.json"), { force: true });
      await rm(path(sessionId, ".events.jsonl"), { force: true });
    },
  };
}
