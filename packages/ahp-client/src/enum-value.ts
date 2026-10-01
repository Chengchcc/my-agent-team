/** Protocol kinds are const enums, and `isolatedModules` forbids indexing them at value level.
 *
 *  Take the member at TYPE level and assert once, here, at value level: every other field of the
 *  object literal still gets checked by the compiler, which a whole-object cast would defeat. The
 *  host's projection states the same rule next to its own literals. */
export function enumValue<T extends string>(value: string): T {
  return value as T;
}
