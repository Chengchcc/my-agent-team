export function ulid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 26);
}
