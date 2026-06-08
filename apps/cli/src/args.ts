/** Parse a `--key=value` flag from argv. Returns undefined if not found. */
export function parseFlag(args: string[], key: string): string | undefined {
  return args.find((a) => a.startsWith(`--${key}=`))?.split("=")[1];
}

/** Check if a boolean `--flag` is present in argv. */
export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(`--${flag}`);
}

/** Convenience for --rm=<id> */
export function resolveRmAgentId(args: string[]): string | undefined {
  return parseFlag(args, "rm");
}

/** Convenience for --hard */
export function hasHardFlag(args: string[]): boolean {
  return hasFlag(args, "hard");
}
