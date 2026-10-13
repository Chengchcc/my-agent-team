import { expect, test } from "bun:test";

/** ADR 0043 decision 2, checked the way it will actually be violated: by a
 *  bundler. Importing the core entry must not drag fastembed/onnxruntime into
 *  an artifact, and the fastembed entry must genuinely carry it — otherwise the
 *  negative assertion below would pass for the wrong reason. */
async function bundle(entry: string): Promise<string> {
  const built = await Bun.build({
    entrypoints: [`src/${entry}`],
    target: "bun",
    write: false,
  });
  expect(built.success).toBe(true);
  const [output] = built.outputs;
  return output ? await output.text() : "";
}

test("the core entry does not pull fastembed in", async () => {
  expect(await bundle("index.ts")).not.toContain("fastembed");
}, 30_000);

test("the fastembed entry does, so the check above is not vacuous", async () => {
  expect(await bundle("fastembed.ts")).toContain("fastembed");
}, 30_000);
