import type { SkillPackPort } from "./ports.js";

let _port: SkillPackPort | null = null;

/** Set the singleton skill-pack port (called once at bootstrap). */
export function setSkillPackPort(port: SkillPackPort): void {
  _port = port;
}

/** Get the singleton skill-pack port, or null if not yet initialized. */
export function getSkillPackPort(): SkillPackPort | null {
  return _port;
}
