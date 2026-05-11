declare module 'bun:sqlite' {
  export class Database {
    constructor(filename: string, options?: { create?: boolean; readonly?: boolean });
    run(sql: string, ...params: unknown[]): { changes: number };
    query(sql: string): Statement;
    prepare(sql: string): Statement;
    loadExtension(file: string, entrypoint?: string): void;
    close(): void;
  }

  export class Statement {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number };
  }
}
