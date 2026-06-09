import type { EpgEntry } from './types.js';

export function parseEpgTime(timeStr: string): Date {
  const m = timeStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{2})(\d{2})/);
  if (m) {
    const utc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
    const tzOffset = (+m[7]!) * 60 + (+m[8]!);
    return new Date(utc - tzOffset * 60000);
  }
  const m2 = timeStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m2) return new Date(0);
  return new Date(Date.UTC(+m2[1]!, +m2[2]! - 1, +m2[3]!, +m2[4]!, +m2[5]!, +m2[6]!));
}

export function formatEpgTime(timeStr: string): string {
  const d = parseEpgTime(timeStr);
  if (d.getTime() === 0) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export function buildEpgIndex(epgData: EpgEntry[]): Map<string, EpgEntry[]> {
  const index = new Map<string, EpgEntry[]>();
  for (const e of epgData) {
    const key = normalizeEpgId(e.channelId);
    const list = index.get(key) ?? [];
    list.push(e);
    index.set(key, list);
  }
  index.forEach(entries => {
    entries.sort((a, b) => parseEpgTime(a.start).getTime() - parseEpgTime(b.start).getTime());
  });
  return index;
}

export function getEpgChannelList(epgIndex: Map<string, EpgEntry[]>): Array<{ normId: string; channelId: string; sampleTitle: string }> {
  const list: Array<{ normId: string; channelId: string; sampleTitle: string }> = [];
  epgIndex.forEach((entries, normId) => {
    const entry = entries[0];
    if (entry) {
      list.push({ normId, channelId: entry.channelId, sampleTitle: entry.title });
    }
  });
  return list.sort((a, b) => a.normId.localeCompare(b.normId));
}

export function findCurrentEpg(epgIndex: Map<string, EpgEntry[]> | null, tvgId: string, now?: Date): EpgEntry | null {
  if (!epgIndex) return null;
  const key = normalizeEpgId(tvgId);
  const entries = epgIndex.get(key);
  if (!entries) return null;
  const currentTime = now ?? new Date();
  return entries.find(e => {
    const start = parseEpgTime(e.start);
    const stop = parseEpgTime(e.stop);
    return start <= currentTime && stop >= currentTime;
  }) ?? null;
}

export function parseXMLTV(xml: string): EpgEntry[] {
  const programmes: EpgEntry[] = [];
  const blockRe = /<programme\s+([\s\S]*?)<\/programme>/g;
  let block;
  while ((block = blockRe.exec(xml)) !== null) {
    const tag = block[1]!;
    const ch = tag.match(/channel="([^"]*)"/);
    const st = tag.match(/start="([^"]*)"/);
    const sp = tag.match(/stop="([^"]*)"/);
    const ti = tag.match(/<title[^>]*>(?:<!\[CDATA\[)?([^\]<]*?)(?:\]\]>)?<\/title>/);
    if (!ch || !st || !sp || !ti) continue;
    const de = tag.match(/<desc[^>]*>(?:<!\[CDATA\[)?([^\]<]*?)(?:\]\]>)?<\/desc>/);
    programmes.push({
      channelId: ch[1]!,
      start: st[1]!,
      stop: sp[1]!,
      title: ti[1]!.trim(),
      description: de ? de[1]!.trim() : '',
    });
  }
  return programmes;
}

function normalizeEpgId(id: string): string {
  return id.replace(/@[^.@]*/g, '').toLowerCase().trim();
}
