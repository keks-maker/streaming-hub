import type { TvChannel, TvChannelGroup } from './types.js';

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, 12);
}

/**
 * Parst eine M3U-Playlist in TvChannel-Listen (gruppiert).
 */
export function parseM3U(
  m3uContent: string,
  sourceId: string,
): TvChannelGroup[] {
  const groups = new Map<string, TvChannel[]>();
  const lines = m3uContent.split('\n');

  let currentName = '';
  let currentLogo: string | undefined;
  let currentTvgId: string | undefined;
  let currentGroup = 'Unsortiert';

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#EXTINF:')) {
      const tvgIdMatch = trimmed.match(/tvg-id="([^"]*)"/);
      currentTvgId = tvgIdMatch?.[1] ?? undefined;

      const logoMatch = trimmed.match(/tvg-logo="([^"]*)"/);
      currentLogo = logoMatch?.[1] ?? undefined;

      const groupMatch = trimmed.match(/group-title="([^"]*)"/);
      currentGroup = groupMatch?.[1] ?? 'Unsortiert';

      // Name = alles nach dem ersten Komma außerhalb der key="value"-Attribute.
      // Die alte Regex (/,([^,]+)$/) nahm alles nach dem LETZTEN Komma und
      // brach damit bei Sendernamen mit Komma ("Das Erste, HD") oder Kommas
      // in Attribut-Werten (group-title="Nachrichten, Dokus").
      // Fallback auf die alte Regex für nicht standardkonforme Zeilen.
      const nameMatch =
        trimmed.match(/^#EXTINF:\s*-?\d+(?:\.\d+)?(?:\s+[\w.-]+="[^"]*")*\s*,\s*(.+)$/i) ??
        trimmed.match(/,([^,]+)$/);
      currentName = nameMatch?.[1]?.trim() ?? '';
      continue;
    }

    if (
      currentName &&
      !trimmed.startsWith('#') &&
      (trimmed.startsWith('http://') || trimmed.startsWith('https://'))
    ) {
      const group = groups.get(currentGroup) ?? [];
      group.push({
        id: `${sourceId}:${simpleHash(trimmed)}`,
        name: currentName,
        logo: currentLogo,
        url: trimmed,
        group: currentGroup,
        tvgId: currentTvgId,
        sourceId,
      });
      groups.set(currentGroup, group);

      currentName = '';
      currentLogo = undefined;
      currentTvgId = undefined;
    }
  }

  return [...groups.entries()]
    .map(([label, channels]) => ({ label, channels }))
    .sort((a, b) => {
      if (a.label === 'Unsortiert') return 1;
      if (b.label === 'Unsortiert') return -1;
      return a.label.localeCompare(b.label, 'de');
    });
}

/**
 * Sucht in Kanälen nach einem Suchbegriff.
 */
export function searchChannels(
  groups: TvChannelGroup[],
  query: string,
): TvChannelGroup[] {
  const q = query.toLowerCase();
  return groups
    .map((g) => ({
      ...g,
      channels: g.channels.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.group.toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.channels.length > 0);
}

/**
 * Result of parseM3UFull: grouped + flat channels, plus EPG URLs.
 */
export interface M3UFullResult {
  groups: TvChannelGroup[];
  channels: TvChannel[];
  epgUrls: string[];
}

/**
 * Parsed M3U with EPG URL extraction in addition to channel groups.
 * Also returns a flat channels array for Desktop compatibility.
 */
export function parseM3UFull(
  m3uContent: string,
  sourceId: string,
): M3UFullResult {
  const groups = parseM3U(m3uContent, sourceId);
  const epgUrls = extractEpgUrls(m3uContent);
  const channels = flattenM3U(groups);
  return { groups, channels, epgUrls };
}

function extractEpgUrls(content: string): string[] {
  const urls: string[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Übliche Varianten: x-tvg-url (Standard) und url-tvg (verbreitetes Pendant)
    const tvgUrlMatch = trimmed.match(/(?:x-tvg-url|url-tvg)="([^"]+)"/i);
    if (tvgUrlMatch && !urls.includes(tvgUrlMatch[1]!)) {
      urls.push(tvgUrlMatch[1]!);
    }
    const sourceMatch = trimmed.match(/^(?:#URLTV-SOURCE|#EPG-URL)\s*:\s*(\S+)/i);
    if (sourceMatch && !urls.includes(sourceMatch[1]!)) {
      urls.push(sourceMatch[1]!);
    }
  }
  return urls;
}

/**
 * Flattens grouped channels from parseM3U into a single array.
 */
export function flattenM3U(groups: TvChannelGroup[]): TvChannel[] {
  return groups.flatMap(g => g.channels);
}
