import { writeFile, rename, unlink, access, constants } from 'fs/promises';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = filePath + '.tmp';
  const dir = dirname(filePath);

  try {
    await access(dir);
  } catch {
    mkdirSync(dir, { recursive: true });
  }

  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}

export async function atomicRead<T>(filePath: string, defaultValue: T): Promise<string | T> {
  try {
    await access(filePath, constants.R_OK);
    const { readFile } = await import('fs/promises');
    return await readFile(filePath, 'utf-8');
  } catch {
    return defaultValue;
  }
}

export async function atomicDelete(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'ENOENT') {
      return
    }
    throw err
  }
}
