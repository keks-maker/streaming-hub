import type { MediathekSource, MediathekEntry, MediathekSearchResult } from './types.js';

export const DEFAULT_MEDIATHEK_SOURCES: MediathekSource[] = [
  {
    provider: 'ard',
    query: '',
    apiUrl: 'https://mediathekviewweb.de/feed',
  },
  {
    provider: 'zdf',
    query: '',
    apiUrl: 'https://mediathekviewweb.de/feed',
  },
  {
    provider: 'arte',
    query: '',
    apiUrl: 'https://mediathekviewweb.de/feed',
  },
];

export function buildSearchUrl(
  source: MediathekSource,
  query: string,
  options?: {
    channel?: string;
    durationMin?: number;
    durationMax?: number;
    future?: boolean;
  },
): string {
  const params = new URLSearchParams();
  params.set('query', query);
  if (options?.channel) params.set('channel', options.channel);
  if (options?.durationMin != null) params.set('durationMin', String(options.durationMin));
  if (options?.durationMax != null) params.set('durationMax', String(options.durationMax));
  if (options?.future !== undefined) params.set('future', String(options.future));
  return `${source.apiUrl}?${params.toString()}`;
}

export function parseSearchResponse(
  rssXml: string,
  channelFilter?: string,
): MediathekSearchResult {
  const allEntries = parseRssItems(rssXml);
  const filtered = channelFilter
    ? allEntries.filter(e => e.creator.toUpperCase().includes(channelFilter.toUpperCase()))
    : allEntries;
  return {
    query: extractQueryFromRss(rssXml) || '',
    filtered,
    allHits: allEntries,
  };
}

function parseRssItems(xml: string): MediathekEntry[] {
  const entries: MediathekEntry[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let block;
  while ((block = itemRe.exec(xml)) !== null) {
    const data = block[1]!;
    const entry = parseSingleItem(data);
    if (entry) entries.push(entry);
  }
  return entries;
}

function parseSingleItem(data: string): MediathekEntry | null {
  const title = extractXmlText(data, 'title');
  if (!title) return null;

  const link = extractXmlText(data, 'link');
  const guid = extractXmlText(data, 'guid');
  const id = guid || link || title;
  const enclosureUrl = extractXmlAttr(data, 'enclosure', 'url');
  const enclosureType = extractXmlAttr(data, 'enclosure', 'type');
  const enclosureLength = extractXmlAttr(data, 'enclosure', 'length');

  return {
    id,
    title,
    description: extractXmlText(data, 'description') || '',
    videoUrl: enclosureUrl || link || '',
    websiteUrl: extractXmlText(data, 'websiteUrl') || '',
    creator: extractXmlTextDc(data, 'creator') || '',
    category: extractXmlText(data, 'category') || '',
    duration: parseInt(extractXmlText(data, 'duration') || '0', 10),
    fileSize: enclosureLength ? parseInt(enclosureLength, 10) : undefined,
    videoType: enclosureType || (link?.includes('.m3u8') ? 'application/x-mpegURL' : 'video/mp4'),
    pubDate: extractXmlText(data, 'pubDate') || '',
  };
}

function extractXmlText(xml: string, tag: string): string | null {
  const re = new RegExp(
    `<${tag}[^>]*>(?:<!\\[CDATA\\[)?([^\\]<]*?)(?:\\]\\]>)?<\\/${tag}>`,
    'i',
  );
  const m = xml.match(re);
  return m ? m[1]!.trim() : null;
}

function extractXmlAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? m[1]! : null;
}

function extractXmlTextDc(xml: string, tag: string): string | null {
  const re = new RegExp(`<dc:${tag}[^>]*>(?:<!\\[CDATA\\[)?([^\\]<]*?)(?:\\]\\]>)?<\\/dc:${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1]!.trim() : null;
}

function extractQueryFromRss(xml: string): string | null {
  const m = xml.match(/<title><!\[CDATA\[MVW - (.*?) \|/);
  return m ? m[1]! : null;
}
