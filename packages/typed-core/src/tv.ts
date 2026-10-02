import type { TvChannel, TvSource, ChannelListItem } from './types.js';

export interface MediathekMatch {
  serviceId: string;
  searchUrl: string;
}

export const mediathekChannelMap: Array<{ match: RegExp; serviceId: string; searchUrl: string }> = [
  { match: /^(DasErste|ARD|BR|HR|MDR|NDR|RB|RBB|SR|SWR|WDR|tagesschau24|one|phoenix|ARD-alpha)/i, serviceId: 'ard', searchUrl: 'https://www.ardmediathek.de/suche/' },
  { match: /^(ZDF|3sat|ZDFinfo|ZDFneo|ZDFdoku)/i, serviceId: 'zdf', searchUrl: 'https://www.zdf.de/suche?q=' },
  { match: /^ARTE/i, serviceId: 'arte', searchUrl: 'https://www.arte.tv/de/search/?q=' },
];

export function getMediathekForChannel(tvgIdOrName: string): MediathekMatch | null {
  return mediathekChannelMap.find(e => e.match.test(tvgIdOrName)) ?? null;
}

/**
 * Normalisiert TV-Sender-IDs identisch zur EPG-Normalisierung (epg.ts):
 * entfernt das Suffix ab "@" bis zum nächsten Punkt ("ard@hdr.de" → "ard.de").
 * Vorher entfernte der Regex hier alles ab "@" bis zum Zeilenende
 * ("ard@hdr.de" → "ard") – dadurch schlug der EPG-Abgleich zwischen beiden
 * Funktionen fehl.
 */
export function normalizeTvId(id: string): string {
  return (id || '').replace(/@[^.@]*/g, '').toLowerCase().trim();
}

export function isFavorite(ch: TvChannel, sources: TvSource[]): boolean {
  const source = sources.find(s => s.id === ch.sourceId);
  return !!(source?.favorites?.includes(ch.id));
}

// ─── Zapping-Reihenfolge (W3) ──────────────────────────────────
//
// ArrowUp/Down zappt ausschließlich über die Favoriten des aktiven
// Quellservices. Die Reihenfolge stammt aus der Favoriten-Sidebar.
export function buildZapOrder(channels: TvChannel[], sources: TvSource[]): string[] {
  const source = channels.length ? sources.find(s => s.id === channels[0]!.sourceId) : undefined;
  const channelIds = new Set(channels.map(ch => ch.id));
  return (source?.favorites ?? []).filter(id => channelIds.has(id));
}

export function filterChannels(
  channels: TvChannel[],
  sourceIds: string[],
  filter: string,
): TvChannel[] {
  let filtered = channels.filter(ch => sourceIds.includes(ch.sourceId ?? ''));
  const q = filter.toLowerCase().trim();
  if (q) {
    filtered = filtered.filter(ch =>
      ch.name.toLowerCase().includes(q) ||
      ch.group.toLowerCase().includes(q)
    );
  }
  return filtered;
}

export function groupChannels(channels: TvChannel[]): Record<string, TvChannel[]> {
  const groups: Record<string, TvChannel[]> = {};
  for (const ch of channels) {
    const g = groups[ch.group];
    if (g) {
      g.push(ch);
    } else {
      groups[ch.group] = [ch];
    }
  }
  return groups;
}

export function separateFavorites(
  channels: TvChannel[],
  sources: TvSource[],
): { favorites: TvChannel[]; regular: TvChannel[] } {
  const favorites: TvChannel[] = [];
  const regular: TvChannel[] = [];
  for (const ch of channels) {
    if (isFavorite(ch, sources)) {
      favorites.push(ch);
    } else {
      regular.push(ch);
    }
  }
  return { favorites, regular };
}

export function buildChannelList(
  currentChannel: TvChannel,
  allChannels: TvChannel[],
  sources: TvSource[],
): { channels: ChannelListItem[]; currentIndex: number } {
  const sourceId = currentChannel.sourceId;
  // W3: On-Screen-Senderliste folgt derselben Reihenfolge wie das Zapping –
  // alle Sender des Quellservices, Favoriten zuerst (Sidebar-Reihenfolge).
  const sourceChannels = allChannels.filter(c => c.sourceId === sourceId);
  const order = buildZapOrder(sourceChannels, sources);
  const byId = new Map(sourceChannels.map(c => [c.id, c]));
  const sorted: ChannelListItem[] = [];
  for (const id of order) {
    const c = byId.get(id);
    if (c) sorted.push({ id: c.id, name: c.name, logo: c.logo ?? '' });
  }
  return {
    channels: sorted,
    currentIndex: sorted.findIndex(c => c.id === currentChannel.id),
  };
}

export function getNextChannelId(
  currentId: string,
  channels: TvChannel[],
  sources: TvSource[],
  dir: number,
): string | null {
  const current = channels.find(c => c.id === currentId);
  if (!current) return null;
  const sourceId = current.sourceId;
  if (!sourceId) return null;
  const sourceChannels = channels.filter(ch => ch.sourceId === sourceId);
  // W3: ausschließlich über Favoriten in Sidebar-Reihenfolge zapfen.
  const order = buildZapOrder(sourceChannels, sources);
  if (!order.length) return null;
  const idx = order.indexOf(currentId);
  const step = dir < 0 ? -1 : 1;
  if (idx !== -1) {
    return order[(idx + step + order.length) % order.length] ?? null;
  }

  // Ein aktiver Nicht-Favorit wird in Pfeilrichtung nach dem nächsten
  // Favoriten durchsucht; die Suche läuft am Anfang/Ende wieder weiter.
  const currentIndex = sourceChannels.findIndex(ch => ch.id === currentId);
  if (currentIndex === -1) return null;
  for (let offset = 1; offset <= sourceChannels.length; offset++) {
    const candidate = sourceChannels[(currentIndex + step * offset + sourceChannels.length) % sourceChannels.length];
    if (candidate && order.includes(candidate.id)) return candidate.id;
  }
  return null;
}

export function applyChannelOverrides(
  channels: TvChannel[],
  source: TvSource,
): TvChannel[] {
  const srcOverrides = source.channelOverrides ?? {};
  const baseUrl = source.baseUrl ?? '';
  return channels.map(ch => {
    const ov = srcOverrides[ch.id];
    if (!ov) return ch;
    const resolved = { ...ch, ...ov };
    if (ov.tvgLogo && !ov.tvgLogo.startsWith('http://') && !ov.tvgLogo.startsWith('https://') && !ov.tvgLogo.startsWith('file://') && baseUrl) {
      resolved.logo = baseUrl + ov.tvgLogo;
    }
    return resolved;
  });
}

export function applySortOrder(
  channels: TvChannel[],
  sortOrder: string[],
): TvChannel[] {
  if (!sortOrder.length) return channels;
  const ordered: TvChannel[] = [];
  const unordered: TvChannel[] = [];
  const remaining = [...channels];
  sortOrder.forEach(id => {
    const idx = remaining.findIndex(c => c.id === id);
    if (idx !== -1) ordered.push(remaining.splice(idx, 1)[0]!);
  });
  return ordered.concat(remaining);
}
