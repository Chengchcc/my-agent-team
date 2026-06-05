import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { input, select } from "@inquirer/prompts";

const rootDir = path.resolve(import.meta.dir, "..");
const templateDir = path.join(rootDir, "_template", "package");

function normalizeDirectoryName(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function assertSafeDirectoryName(value: string): void {
  if (value.length === 0) {
    throw new Error("Directory name is required.");
  }

  if (value.includes("..") || path.isAbsolute(value)) {
    throw new Error("Directory name must be relative and cannot contain '..'.");
  }
}

async function replacePlaceholders(
  filePath: string,
  replacements: Record<string, string>,
): Promise<void> {
  let content = await readFile(filePath, "utf8");

  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }

  await writeFile(filePath, content);
}

async function main(): Promise<void> {
  const area = await select({
    message: "Where should the package be created?",
    choices: [
      { name: "apps", value: "apps" },
      { name: "packages", value: "packages" },
    ],
  });

  const directoryName = normalizeDirectoryName(
    await input({
      message: "Directory name:",
      required: true,
    }),
  );
  assertSafeDirectoryName(directoryName);

  const defaultPackageName = `@my-agent-team/${directoryName.split("/").at(-1)}`;
  const packageName = await input({
    message: "Package name:",
    default: defaultPackageName,
    required: true,
  });

  const description = await input({
    message: "Description:",
    default: `${packageName} package`,
  });

  const targetDir = path.join(rootDir, area, directoryName);

  if (existsSync(targetDir)) {
    throw new Error(`Target already exists: ${path.relative(rootDir, targetDir)}`);
  }

  await mkdir(path.dirname(targetDir), { recursive: true });
  await cp(templateDir, targetDir, { recursive: true });

  await replacePlaceholders(path.join(targetDir, "package.json"), {
    name: packageName.trim(),
    description: description.trim(),
  });
  await replacePlaceholders(path.join(targetDir, "src", "index.ts"), {
    name: packageName.trim(),
    description: description.trim(),
  });

  const relativeTarget = path.relative(rootDir, targetDir);
  console.log(`Created ${relativeTarget}`);
  console.log("Next steps:");
  console.log("  bun install");
  console.log(`  bun run --filter ${packageName.trim()} typecheck`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
