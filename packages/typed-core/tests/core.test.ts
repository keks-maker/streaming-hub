import { describe, it, expect } from 'vitest';
import type { TvChannel } from '../src/types.js';
import { compareVersions, checkForUpdate, parseTagsFromLsRemote } from '../src/updater.js';
import { parseM3U, parseM3UFull, flattenM3U, searchChannels } from '../src/tvsources.js';
import { addHistoryEntry, searchHistory } from '../src/history.js';
import { mergeConfig, validateConfig } from '../src/config.js';
import { loadServices } from '../src/services.js';
import { escapeHtml, decodeEntities, normalizeUrl, formatTimestamp } from '../src/format.js';
import { parseEpgTime, formatEpgTime, buildEpgIndex, getEpgChannelList, findCurrentEpg } from '../src/epg.js';
import { getMediathekForChannel, normalizeTvId, isFavorite, buildZapOrder, filterChannels, groupChannels, separateFavorites, buildChannelList, getNextChannelId, applyChannelOverrides, applySortOrder } from '../src/tv.js';
import { DEFAULT_MEDIATHEK_SOURCES, buildSearchUrl, parseSearchResponse } from '../src/mediathek.js';

// ─── Updater ─────────────────────────────────────────────────

const SAMPLE_TAGS = `abc123 refs/tags/v0.4.26
def456 refs/tags/v0.4.27
ghi789 refs/tags/v0.4.24`;

it('parseTagsFromLsRemote', () => {
  const tags = parseTagsFromLsRemote(SAMPLE_TAGS);
  expect(tags).toEqual(['0.4.24', '0.4.26', '0.4.27']);
});

it('checkForUpdate – has update', () => {
  const info = checkForUpdate('0.4.24', ['0.4.24', '0.4.25', '0.4.27']);
  expect(info.hasUpdate).toBe(true);
  expect(info.latestVersion).toBe('0.4.27');
});

it('checkForUpdate – no update', () => {
  const info = checkForUpdate('0.4.27', ['0.4.24', '0.4.26', '0.4.27']);
  expect(info.hasUpdate).toBe(false);
});

// ─── Services ────────────────────────────────────────────────

it('loadServices – built-in + custom', () => {
  const custom = [{ id: 'meins', name: 'Mein Dienst', url: 'https://x', icon: 'x.svg' }];
  const all = loadServices(custom);
  expect(all.find((s) => s.id === 'netflix')).toBeDefined();
  expect(all.find((s) => s.id === 'meins')).toBeDefined();
});

// ─── TV Sources (M3U) ────────────────────────────────────────

const SAMPLE_M3U = `#EXTM3U
#EXTINF:-1 tvg-id="das-erste" tvg-logo="https://example.com/ard.png" group-title="Öffentlich-Rechtlich",Das Erste
https://example.com/das-erste.m3u8
#EXTINF:-1 tvg-logo="https://example.com/zdf.png" group-title="Öffentlich-Rechtlich",ZDF
https://example.com/zdf.m3u8
#EXTINF:-1 group-title="Privat",RTL
https://example.com/rtl.m3u8`;

it('parseM3U', () => {
  const groups = parseM3U(SAMPLE_M3U, 'test');
  expect(groups.length).toBe(2);
  const pub = groups.find((g) => g.label === 'Öffentlich-Rechtlich')!;
  expect(pub.channels.length).toBe(2);
  expect(pub.channels[0]!.name).toBe('Das Erste');
});

it('parseM3UFull', () => {
  const result = parseM3UFull(SAMPLE_M3U, 'test');
  expect(result.groups.length).toBe(2);
  expect(result.channels.length).toBe(3);
  expect(result.epgUrls.length).toBe(0);
  expect(result.channels[0]!.sourceId).toBe('test');
});

it('parseM3UFull – EPG URL extraction', () => {
  const m3uWithEpg = `#EXTM3U x-tvg-url="https://epg.example.com/guide.xml"
#EXTINF:-1 group-title="ARD",Das Erste
https://example.com/ard.m3u8
#URLTV-SOURCE:https://epg.example.com/guide2.xml
#EXTINF:-1 group-title="ARD",ZDF
https://example.com/zdf.m3u8`;
  const result = parseM3UFull(m3uWithEpg, 'test');
  expect(result.epgUrls).toContain('https://epg.example.com/guide.xml');
  expect(result.epgUrls).toContain('https://epg.example.com/guide2.xml');
  expect(result.channels.length).toBe(2);
});

it('parseM3UFull – url-tvg EPG URL extraction', () => {
  const result = parseM3UFull(
    '#EXTM3U url-tvg="https://epg.example.com/url-tvg.xml"\n' +
      '#EXTINF:-1,Das Erste\nhttps://example.com/ard.m3u8',
    'test',
  );
  expect(result.epgUrls).toEqual(['https://epg.example.com/url-tvg.xml']);
});

it('flattenM3U', () => {
  const groups = parseM3U(SAMPLE_M3U, 'test');
  const flat = flattenM3U(groups);
  expect(flat.length).toBe(3);
  expect(flat[0]!.name).toBe('Das Erste');
});

it('searchChannels', () => {
  const groups = parseM3U(SAMPLE_M3U, 'test');
  const found = searchChannels(groups, 'zdf');
  expect(found.length).toBe(1);
  expect(found[0]!.channels.length).toBe(1);
  expect(found[0]!.channels[0]!.name).toBe('ZDF');
});

// ─── History ─────────────────────────────────────────────────

it('addHistoryEntry – dedup', () => {
  const entry = { title: 'Film A', serviceKey: 'netflix', serviceName: 'Netflix', timestamp: new Date().toISOString() };
  const h = addHistoryEntry([entry], entry);
  expect(h.length).toBe(1);
});

it('searchHistory', () => {
  const h = [
    { title: 'Dark', serviceKey: 'netflix', serviceName: 'Netflix', timestamp: '2026-01-01' },
    { title: 'Tatort', serviceKey: 'ard', serviceName: 'ARD', timestamp: '2026-01-02' },
  ];
  expect(searchHistory(h, 'tatort').length).toBe(1);
  expect(searchHistory(h, 'xxx').length).toBe(0);
});

// ─── Config ──────────────────────────────────────────────────

it('mergeConfig', () => {
  const merged = mergeConfig({ customSources: [], pinnedServices: ['netflix'], tvSidebarOpen: false, volume: 50 }, { volume: 80 });
  expect(merged.volume).toBe(80);
  expect(merged.pinnedServices).toEqual(['netflix']);
});

it('validateConfig', () => {
  expect(validateConfig({ customSources: [], pinnedServices: [], volume: 50 })).toBe(true);
  expect(validateConfig({ customSources: 'nope' })).toBe(false);
  expect(validateConfig(null)).toBe(false);
});

// ─── Format ───────────────────────────────────────────────────

it('escapeHtml', () => {
  expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  expect(escapeHtml('normal text')).toBe('normal text');
});

it('decodeEntities', () => {
  expect(decodeEntities('&lt;tag&gt;')).toBe('<tag>');
  expect(decodeEntities('&amp; &quot; &#039;')).toBe('& " \'');
});

it('normalizeUrl', () => {
  expect(normalizeUrl('example.com')).toBe('https://example.com');
  expect(normalizeUrl('https://example.com')).toBe('https://example.com');
  expect(normalizeUrl('  ')).toBe('');
});

it('formatTimestamp', () => {
  const result = formatTimestamp('2026-06-09T12:30:00');
  expect(result).toContain('12:30');
});

// ─── EPG ──────────────────────────────────────────────────────

it('parseEpgTime – with timezone', () => {
  // "14:30 +0200" entspricht 12:30 UTC. Absichtlich zeitzonenunabhängig
  // geprüft (getTime statt getHours), damit der Test nicht nur auf
  // Rechnern in UTC+2 besteht.
  const d = parseEpgTime('20260609143000 +0200');
  expect(d.getTime()).toBe(Date.UTC(2026, 5, 9, 12, 30, 0));
});

it('parseEpgTime – without timezone (UTC)', () => {
  const d = parseEpgTime('20260609120000');
  expect(d.getUTCHours()).toBe(12);
});

it('parseEpgTime – invalid', () => {
  const d = parseEpgTime('');
  expect(d.getTime()).toBe(0);
});

it('formatEpgTime', () => {
  expect(formatEpgTime('')).toBe('');
  expect(formatEpgTime('20260609143000 +0200')).toMatch(/^\d{2}:\d{2}$/);
});

it('buildEpgIndex', () => {
  const data = [
    { channelId: 'ARD', title: 'Tagesschau', start: '20260609120000', stop: '20260609121500' },
    { channelId: 'ARD', title: 'Wetter', start: '20260609121500', stop: '20260609122000' },
    { channelId: 'ZDF', title: 'heute', start: '20260609120000', stop: '20260609121500' },
  ];
  const index = buildEpgIndex(data);
  expect(index.size).toBe(2);
  expect(index.get('ard')!.length).toBe(2);
  expect(index.get('zdf')!.length).toBe(1);
});

it('getEpgChannelList', () => {
  const data = [
    { channelId: 'ZDF', title: 'heute', start: '20260609120000', stop: '20260609121500' },
    { channelId: 'ARD', title: 'Tagesschau', start: '20260609120000', stop: '20260609121500' },
  ];
  const index = buildEpgIndex(data);
  const list = getEpgChannelList(index);
  expect(list.length).toBe(2);
  expect(list[0]!.normId).toBe('ard');
  expect(list[1]!.normId).toBe('zdf');
});

it('findCurrentEpg', () => {
  const data = [
    { channelId: 'ARD', title: 'Tagesschau', start: '20260608120000', stop: '20260608121500' },
    { channelId: 'ARD', title: 'Sportschau', start: '20260609120000', stop: '20260609140000' },
  ];
  const index = buildEpgIndex(data);
  const now = new Date(Date.UTC(2026, 5, 9, 13, 0, 0));
  const found = findCurrentEpg(index, 'ARD', now);
  expect(found).not.toBeNull();
  expect(found!.title).toBe('Sportschau');
});

it('findCurrentEpg – no match', () => {
  const data = [{ channelId: 'ARD', title: 'Alt', start: '20260601000000', stop: '20260601010000' }];
  const index = buildEpgIndex(data);
  const now = new Date('2026-06-09T13:00:00');
  expect(findCurrentEpg(index, 'ARD', now)).toBeNull();
});

// ─── TV ───────────────────────────────────────────────────────

it('getMediathekForChannel', () => {
  const m = getMediathekForChannel('DasErste');
  expect(m).not.toBeNull();
  expect(m!.serviceId).toBe('ard');

  expect(getMediathekForChannel('RTL')).toBeNull();
});

it('normalizeTvId', () => {
  // Einheitliche Semantik wie normalizeEpgId (epg.ts): Suffix ab "@" bis
  // zum nächsten Punkt entfernen ("ard@hdr.de" → "ard.de"). Reale M3U-IDs
  // tragen Qualitäts-/Regionssuffixe ohne Punkt ("DasErste.de@HD").
  expect(normalizeTvId('ARD@some.host')).toBe('ard.host');
  expect(normalizeTvId('DasErste.de@HD')).toBe('daserste.de');
  expect(normalizeTvId('  ZDF  ')).toBe('zdf');
});

it('isFavorite', () => {
  const sources = [{ id: 'src1', name: 'Src', url: 'x', order: 0, favorites: ['ch1'] }];
  expect(isFavorite({ id: 'ch1', name: 'Ch1', url: 'x', group: 'G', sourceId: 'src1' }, sources)).toBe(true);
  expect(isFavorite({ id: 'ch2', name: 'Ch2', url: 'x', group: 'G', sourceId: 'src1' }, sources)).toBe(false);
});

it('filterChannels', () => {
  const channels: TvChannel[] = [
    { id: '1', name: 'ARD', url: 'x', group: 'Public', sourceId: 's1' },
    { id: '2', name: 'ZDF', url: 'x', group: 'Public', sourceId: 's2' },
    { id: '3', name: 'RTL', url: 'x', group: 'Private', sourceId: 's3' },
  ];
  const result = filterChannels(channels, ['s1', 's3'], '');
  expect(result.length).toBe(2);
  expect(result[0]!.id).toBe('1');

  const filtered = filterChannels(channels, ['s1', 's2', 's3'], 'rtl');
  expect(filtered.length).toBe(1);
  expect(filtered[0]!.name).toBe('RTL');
});

it('groupChannels', () => {
  const channels = [
    { id: '1', name: 'ARD', url: 'x', group: 'Public' },
    { id: '2', name: 'ZDF', url: 'x', group: 'Public' },
    { id: '3', name: 'RTL', url: 'x', group: 'Private' },
  ];
  const groups = groupChannels(channels);
  expect(Object.keys(groups).length).toBe(2);
  expect(groups['Public']!.length).toBe(2);
  expect(groups['Private']!.length).toBe(1);
});

it('separateFavorites', () => {
  const sources = [{ id: 'src1', name: 'Src', url: 'x', order: 0, favorites: ['ch1'] }];
  const channels = [
    { id: 'ch1', name: 'ARD', url: 'x', group: 'G', sourceId: 'src1' },
    { id: 'ch2', name: 'ZDF', url: 'x', group: 'G', sourceId: 'src1' },
  ];
  const { favorites, regular } = separateFavorites(channels, sources);
  expect(favorites.length).toBe(1);
  expect(regular.length).toBe(1);
});

it('buildChannelList', () => {
  const sources = [{ id: 'src1', name: 'Src', url: 'x', order: 0, favorites: ['ch1'] }];
  const channels = [
    { id: 'ch1', name: 'ARD', url: 'x', group: 'G', sourceId: 'src1' },
    { id: 'ch2', name: 'ZDF', url: 'x', group: 'G', sourceId: 'src1' },
  ];
  // W3: Liste enthaelt ALLE Sender des Quellservices, Favorit zuerst;
  // aktiver Sender (ch1, Favorit) steht an Index 0.
  const result = buildChannelList(channels[0]!, channels, sources);
  expect(result.channels.map(c => c.id)).toEqual(['ch1', 'ch2']);
  expect(result.currentIndex).toBe(0);
});

it('getNextChannelId', () => {
  const sources = [{ id: 'src1', name: 'Src', url: 'x', order: 0 }];
  const channels = [
    { id: 'ch1', name: 'ARD', url: 'x', group: 'G', sourceId: 'src1' },
    { id: 'ch2', name: 'ZDF', url: 'x', group: 'G', sourceId: 'src1' },
  ];
  expect(getNextChannelId('ch1', channels, sources, 1)).toBe('ch2');
  expect(getNextChannelId('ch2', channels, sources, 1)).toBe('ch1');
  expect(getNextChannelId('ch2', channels, sources, -1)).toBe('ch1');
});

it('getNextChannelId – zappt über alle Sender, Favoriten zuerst (W3)', () => {
  const sources = [{ id: 'src1', name: 'Src', url: 'x', order: 0, favorites: ['ch2'] }];
  const channels = [
    { id: 'ch1', name: 'ARD', url: 'x', group: 'G', sourceId: 'src1' },
    { id: 'ch2', name: 'ZDF', url: 'x', group: 'G', sourceId: 'src1' },
    { id: 'ch3', name: 'RTL', url: 'x', group: 'G', sourceId: 'src1' },
  ];
  // Reihenfolge: Favoriten zuerst (ch2), dann Rest in Listenreihenfolge (ch1, ch3)
  expect(getNextChannelId('ch2', channels, sources, 1)).toBe('ch1');
  expect(getNextChannelId('ch1', channels, sources, 1)).toBe('ch3');
  expect(getNextChannelId('ch3', channels, sources, 1)).toBe('ch2'); // Wrap-around
  expect(getNextChannelId('ch2', channels, sources, -1)).toBe('ch3');
});

it('buildZapOrder – Favoritenreihenfolge, Rest in Listenreihenfolge', () => {
  const sources = [{ id: 'src1', name: 'Src', url: 'x', order: 0, favorites: ['c', 'a'] }];
  const channels = [
    { id: 'a', name: 'A', url: 'x', group: 'G', sourceId: 'src1' },
    { id: 'b', name: 'B', url: 'x', group: 'G', sourceId: 'src1' },
    { id: 'c', name: 'C', url: 'x', group: 'G', sourceId: 'src1' },
    { id: 'd', name: 'D', url: 'x', group: 'G', sourceId: 'src1' },
  ];
  // Die Sortierreihenfolge aus dem Favoriten-Sortiermodus wird überall genutzt.
  expect(buildZapOrder(channels, sources)).toEqual(['c', 'a', 'b', 'd']);
  // Leere Favoriten => unverändert die Listenreihenfolge
  const noFav: typeof sources = [{ id: 'src1', name: 'Src', url: 'x', order: 0 }];
  expect(buildZapOrder(channels, noFav)).toEqual(['a', 'b', 'c', 'd']);
});

it('buildChannelList – enthält alle Sender des Quellservices (W3)', () => {
  const sources = [{ id: 'src1', name: 'Src', url: 'x', order: 0, favorites: ['ch2'] }];
  const channels = [
    { id: 'ch1', name: 'ARD', url: 'x', group: 'G', sourceId: 'src1' },
    { id: 'ch2', name: 'ZDF', url: 'x', group: 'G', sourceId: 'src1' },
    { id: 'ch3', name: 'RTL', url: 'x', group: 'G', sourceId: 'src1' },
  ];
  // Aktiver Sender ist KEIN Favorit => Liste + Index trotzdem korrekt
  const result = buildChannelList(channels[0]!, channels, sources);
  expect(result.channels.map(c => c.id)).toEqual(['ch2', 'ch1', 'ch3']);
  expect(result.currentIndex).toBe(1);
});

it('applyChannelOverrides', () => {
  const source = { id: 'src1', name: 'Src', url: 'x', order: 0, channelOverrides: { ch1: { name: 'ARD neu' } } };
  const channels = [{ id: 'ch1', name: 'ARD alt', url: 'x', group: 'G' }];
  const result = applyChannelOverrides(channels, source);
  expect(result[0]!.name).toBe('ARD neu');
});

it('applySortOrder', () => {
  const channels = [
    { id: 'c', name: 'C', url: 'x', group: 'G' },
    { id: 'a', name: 'A', url: 'x', group: 'G' },
    { id: 'b', name: 'B', url: 'x', group: 'G' },
  ];
  const result = applySortOrder(channels, ['a', 'b', 'c']);
  expect(result.map(c => c.id)).toEqual(['a', 'b', 'c']);
});

// ─── Mediathek ───────────────────────────────────────────────

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title><![CDATA[MVW - tagesschau | Zukünftige]]></title>
<item>
<title><![CDATA[tagesschau 09:00 Uhr]]></title>
<description><![CDATA[Nachrichten]]></description>
<link>https://example.com/video.mp4</link>
<guid isPermaLink="false">abc123</guid>
<category><![CDATA[tagesschau]]></category>
<dc:creator><![CDATA[ARD]]></dc:creator>
<pubDate>Tue, 09 Jun 2026 07:00:00 GMT</pubDate>
<enclosure url="https://example.com/video.mp4" length="34603008" type="video/mp4"/>
<duration>172</duration>
<websiteUrl>https://www.ardmediathek.de/video/abc</websiteUrl>
</item>
<item>
<title><![CDATA[heute journal]]></title>
<description><![CDATA[Nachrichten aus Deutschland]]></description>
<link>https://example.com/zdf.m3u8</link>
<guid isPermaLink="false">def456</guid>
<category><![CDATA[nachrichten]]></category>
<dc:creator><![CDATA[ZDF]]></dc:creator>
<pubDate>Mon, 08 Jun 2026 21:45:00 GMT</pubDate>
<enclosure url="https://example.com/zdf.m3u8" length="50000000" type="application/x-mpegURL"/>
<duration>1055</duration>
<websiteUrl>https://www.zdf.de/sendung/heute-journal</websiteUrl>
</item>
</channel>
</rss>`;

it('buildSearchUrl', () => {
  const url = buildSearchUrl(DEFAULT_MEDIATHEK_SOURCES[0]!, 'tagesschau', { channel: 'ARD' });
  expect(url).toContain('mediathekviewweb.de/feed');
  expect(url).toContain('query=tagesschau');
  expect(url).toContain('channel=ARD');
});

it('parseSearchResponse – all entries', () => {
  const result = parseSearchResponse(SAMPLE_RSS);
  expect(result.allHits.length).toBe(2);
  expect(result.allHits[0]!.title).toBe('tagesschau 09:00 Uhr');
  expect(result.allHits[0]!.creator).toBe('ARD');
  expect(result.allHits[0]!.duration).toBe(172);
  expect(result.allHits[0]!.videoType).toBe('video/mp4');
});

it('parseSearchResponse – HLS detection', () => {
  const result = parseSearchResponse(SAMPLE_RSS);
  const zdf = result.allHits[1]!;
  expect(zdf.videoType).toBe('application/x-mpegURL');
  expect(zdf.duration).toBe(1055);
  expect(zdf.websiteUrl).toContain('zdf.de');
});

it('parseSearchResponse – channel filter', () => {
  expect(parseSearchResponse(SAMPLE_RSS, 'ARD').filtered.length).toBe(1);
  expect(parseSearchResponse(SAMPLE_RSS, 'ZDF').filtered.length).toBe(1);
  expect(parseSearchResponse(SAMPLE_RSS, 'RTL').filtered.length).toBe(0);
});

it('DEFAULT_MEDIATHEK_SOURCES', () => {
  expect(DEFAULT_MEDIATHEK_SOURCES.length).toBe(3);
  expect(DEFAULT_MEDIATHEK_SOURCES.map(s => s.provider)).toEqual(['ard', 'zdf', 'arte']);
});
