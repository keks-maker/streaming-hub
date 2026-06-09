import type { StreamService } from './types.js';

/**
 * Eingebaute Streaming-Dienste.
 */
export const BUILTIN_SERVICES: StreamService[] = [
  { id: 'netflix',    name: 'Netflix',     url: 'https://www.netflix.com',       icon: 'icons/netflix.svg',      iosAppScheme: 'netflix://' },
  { id: 'youtube',    name: 'YouTube',     url: 'https://www.youtube.com',       icon: 'icons/youtube.svg',      iosAppScheme: 'youtube://' },
  { id: 'primevideo', name: 'Prime Video', url: 'https://www.primevideo.com',    icon: 'icons/primevideo.svg',   iosAppScheme: 'primevideo://' },
  { id: 'twitch',     name: 'Twitch',      url: 'https://www.twitch.tv',         icon: 'icons/twitch.svg',       iosAppScheme: 'twitch://' },
  { id: 'spotify',    name: 'Spotify',     url: 'https://open.spotify.com',      icon: 'icons/spotify.svg',      iosAppScheme: 'spotify://' },
  { id: 'ard',        name: 'ARD',         url: 'https://www.ardmediathek.de',   icon: 'icons/ard.svg',          iosAppScheme: 'ardmediathek://' },
  { id: 'zdf',        name: 'ZDF',         url: 'https://www.zdf.de',            icon: 'icons/zdf.svg',          iosAppScheme: 'zdf://' },
  { id: 'arte',       name: 'ARTE',        url: 'https://www.arte.tv',           icon: 'icons/arte.svg',         iosAppScheme: 'arte://' },
  { id: 'magentatv',   name: 'MagentaTV',   url: 'https://web.magentatv.de',       icon: 'icons/magentatv.svg',     group: 'streaming' as const },
];

/**
 * Lädt Dienste: Built-in + benutzerdefinierte aus Config.
 */
export function loadServices(configServices?: StreamService[]): StreamService[] {
  const custom = configServices ?? [];
  const customIds = new Set(custom.map((s) => s.id));
  return [...BUILTIN_SERVICES.filter((s) => !customIds.has(s.id)), ...custom];
}
