import fs from 'fs/promises';

interface PermissionFile {
  version: 1;
  alwaysAllow: string[];
}

export class PermissionStore {
  private cache: Set<string> | null = null;

  constructor(private readonly filePath: string) {}

  async load(): Promise<Set<string>> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw) as PermissionFile;
      this.cache = new Set(data.alwaysAllow ?? []);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.cache = new Set();
    }
    return this.cache;
  }

  async addAlways(toolName: string): Promise<void> {
    const set = await this.load();
    if (set.has(toolName)) return;
    set.add(toolName);
    await this.persist();
  }

  async removeAlways(toolName: string): Promise<boolean> {
    const set = await this.load();
    const removed = set.delete(toolName);
    if (removed) await this.persist();
    return removed;
  }

  async listAlways(): Promise<string[]> {
    const set = await this.load();
    return [...set];
  }

  async hasAlways(toolName: string): Promise<boolean> {
    const set = await this.load();
    return set.has(toolName);
  }

  private async persist(): Promise<void> {
    const data: PermissionFile = { version: 1, alwaysAllow: [...this.cache!] };
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }
}
