import type { HistoryEntry } from './types.js';

const MAX_HISTORY = 200;

/**
 * Fügt einen Eintrag hinzu (Deduplizierung nach Titel + Service).
 */
export function addHistoryEntry(
  history: HistoryEntry[],
  entry: HistoryEntry,
): HistoryEntry[] {
  const filtered = history.filter(
    (h) => !(h.title === entry.title && h.serviceKey === entry.serviceKey),
  );
  return [entry, ...filtered].slice(0, MAX_HISTORY);
}

/**
 * Filtert History nach Suchbegriff.
 */
export function searchHistory(
  history: HistoryEntry[],
  query: string,
): HistoryEntry[] {
  const q = query.toLowerCase();
  return history.filter(
    (h) =>
      h.title.toLowerCase().includes(q) ||
      h.serviceName.toLowerCase().includes(q),
  );
}

/**
 * Gruppiert History nach Datum (heute, gestern, älter).
 */
export function groupHistoryByDate(
  history: HistoryEntry[],
): Map<string, HistoryEntry[]> {
  const groups = new Map<string, HistoryEntry[]>();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  for (const entry of history) {
    const date = new Date(entry.timestamp);
    let label: string;
    if (date.toDateString() === today.toDateString()) {
      label = 'Heute';
    } else if (date.toDateString() === yesterday.toDateString()) {
      label = 'Gestern';
    } else {
      label = date.toLocaleDateString('de-DE', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    }
    const group = groups.get(label) ?? [];
    group.push(entry);
    groups.set(label, group);
  }

  return groups;
}
