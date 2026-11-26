import { describe, expect, test } from "bun:test";
import type { WorkflowDefinition } from "@chengchenccc/workflow";
import {
  clearWorkflowDraft,
  type DraftStorageLike,
  readWorkflowDraft,
  workflowDraftKey,
  writeWorkflowDraft,
} from "./draft-storage";

function memoryStorage(): DraftStorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const sample: WorkflowDefinition = {
  version: 1,
  id: "nightly-lint",
  meta: { name: "Nightly lint" },
  nodes: [
    { id: "start", type: "start" },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [{ from: "start", to: "done" }],
};

describe("workflow draft storage", () => {
  test("round-trips a valid draft and clears it cleanly", () => {
    const storage = memoryStorage();
    expect(readWorkflowDraft("nightly-lint", storage)).toBeNull();

    writeWorkflowDraft("nightly-lint", sample, storage);
    const loaded = readWorkflowDraft("nightly-lint", storage);
    expect(loaded).not.toBeNull();
    expect(loaded?.definition).toEqual(sample);
    expect(typeof loaded?.updatedAt).toBe("number");

    clearWorkflowDraft("nightly-lint", storage);
    expect(readWorkflowDraft("nightly-lint", storage)).toBeNull();
  });

  test("ignores corrupted or non-definition payloads", () => {
    const storage = memoryStorage();
    storage.setItem(workflowDraftKey("broken"), "{not-json");
    expect(readWorkflowDraft("broken", storage)).toBeNull();

    storage.setItem(workflowDraftKey("invalid"), JSON.stringify({ definition: { foo: 1 } }));
    expect(readWorkflowDraft("invalid", storage)).toBeNull();
  });
});
