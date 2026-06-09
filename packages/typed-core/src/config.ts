import type { AppConfig } from './types.js';

export const DEFAULT_CONFIG: AppConfig = {
  customSources: [],
  pinnedServices: [],
  tvSidebarOpen: false,
  volume: 50,
};

/**
 * Mergt eine Teil-Config in die bestehende (validierte Tiefe = 1).
 */
export function mergeConfig(
  existing: AppConfig,
  partial: Partial<AppConfig>,
): AppConfig {
  return {
    ...existing,
    ...partial,
    // Arrays ersetzen, nicht mergen
    customSources: partial.customSources ?? existing.customSources,
    pinnedServices: partial.pinnedServices ?? existing.pinnedServices,
  };
}

/**
 * Validiert, ob eine Config strukturell korrekt ist (z.B. nach JSON-Import).
 */
export function validateConfig(raw: unknown): raw is AppConfig {
  if (typeof raw !== 'object' || raw === null) return false;
  const c = raw as Record<string, unknown>;
  if (!Array.isArray(c.customSources)) return false;
  if (!Array.isArray(c.pinnedServices ?? [])) return false;
  const vol = c.volume;
  if (vol !== undefined && (typeof vol !== 'number' || vol < 0 || vol > 100)) return false;
  return true;
}
