import { loadSettings } from './loader';
import type { Settings } from './types';

// Eagerly load settings on module import
let cachedSettings: Settings | null = null;

/**
 * Get the current settings, loading if not cached
 */
export async function getSettings(): Promise<Settings> {
  if (!cachedSettings) {
    cachedSettings = await loadSettings();
  }
  return cachedSettings;
}

/**
 * Get the cached settings synchronously (must be loaded first)
 * Use this after initial loading is complete.
 */
export function getSettingsSync(): Settings {
  if (!cachedSettings) {
    throw new Error('Settings not loaded yet. Call getSettings() first.');
  }
  return cachedSettings;
}
