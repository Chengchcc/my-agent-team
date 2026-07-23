export interface ContextKey<T> {
  readonly name: string;
}

export interface RunState {
  get<T>(key: ContextKey<T>): T | undefined;
  set<T>(key: ContextKey<T>, value: T): void;
  has<T>(key: ContextKey<T>): boolean;
  delete<T>(key: ContextKey<T>): void;
  clear(): void;
}
