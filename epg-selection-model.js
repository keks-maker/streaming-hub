// Senderauswahl des Programmführers (Etappe 3.5, EPG-E3/M-Auswahl) — rein und DOM-frei.
//
// Auswahl: Favoriten (Standard) · Alle Sender · eine Quelle · eine Kanalgruppe. Sie ist reiner
// Sitzungszustand (kein Setting) und wirkt in ALLEN Modi (Liste, Raster, Jetzt & Gleich, Suche):
// epg-view.js bildet daraus einmal die Senderliste (channelEntries), alle Modi lesen sie.
// „Sender ohne EPG ausblenden“ (Standard an) steuert nur die Anzeige der Modi, nicht diese Auswahl.

'use strict';

const KINDS = Object.freeze(['favorites', 'all', 'source', 'group']);
const DEFAULT_SELECTION = Object.freeze({ kind: 'favorites', value: '' });
const MAX_VALUE_LENGTH = 200;

/** Beliebige Eingabe → gültige Auswahl { kind, value }; unbekannte Art oder fehlender Wert → Favoriten. */
function normalizeSelection(input) {
  if (!input || typeof input !== 'object') return { ...DEFAULT_SELECTION };
  const kind = input.kind;
  if (kind === 'all') return { kind: 'all', value: '' };
  if (kind === 'source' || kind === 'group') {
    const value = typeof input.value === 'string' ? input.value : '';
    return value && value.length <= MAX_VALUE_LENGTH ? { kind, value } : { ...DEFAULT_SELECTION };
  }
  return { ...DEFAULT_SELECTION };
}

function sameSelection(a, b) {
  const x = normalizeSelection(a);
  const y = normalizeSelection(b);
  return x.kind === y.kind && x.value === y.value;
}

/**
 * Prädikat „Sender gehört zur Auswahl“. Favoriten: isFavorite(channel); Quelle: channel.sourceId;
 * Gruppe: channel.group (Gruppenname der Playlist, wie in der Senderliste).
 */
function selectionPredicate(selection, isFavorite) {
  const sel = normalizeSelection(selection);
  if (sel.kind === 'all') return () => true;
  if (sel.kind === 'source') return channel => !!channel && channel.sourceId === sel.value;
  if (sel.kind === 'group') return channel => !!channel && channel.group === sel.value;
  return channel => typeof isFavorite === 'function' && !!isFavorite(channel);
}

/** Wählbare Gruppen: [{ name, count }] aus den Sendern, alphabetisch (deutsche Sortierung). */
function listGroups(channels) {
  const counts = new Map();
  for (const channel of Array.isArray(channels) ? channels : []) {
    const name = channel && typeof channel.group === 'string' ? channel.group.trim() : '';
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

/**
 * Wählbare Quellen: [{ id, name, count }] — nur Quellen, die Sender liefern, in der Reihenfolge der Quellenliste.
 * sources: [{ id, name }] (Einstellungen), sonst nur die IDs aus den Sendern.
 */
function listSources(channels, sources) {
  const counts = new Map();
  for (const channel of Array.isArray(channels) ? channels : []) {
    const id = channel && typeof channel.sourceId === 'string' ? channel.sourceId : '';
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const out = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source || !counts.has(source.id)) continue;
    out.push({ id: source.id, name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : source.id, count: counts.get(source.id) });
    counts.delete(source.id);
  }
  for (const [id, count] of counts) out.push({ id, name: id, count });
  return out;
}

/** Beschriftung für Knopf und Leerzustände: „Favoriten“, „Alle Sender“, „Quelle X“, „Gruppe X“. */
function selectionLabel(selection, sources) {
  const sel = normalizeSelection(selection);
  if (sel.kind === 'all') return 'Alle Sender';
  if (sel.kind === 'group') return `Gruppe ${sel.value}`;
  if (sel.kind === 'source') {
    const source = (Array.isArray(sources) ? sources : []).find(s => s && s.id === sel.value);
    return `Quelle ${source && source.name ? source.name : sel.value}`;
  }
  return 'Favoriten';
}

module.exports = {
  KINDS,
  DEFAULT_SELECTION,
  normalizeSelection,
  sameSelection,
  selectionPredicate,
  listGroups,
  listSources,
  selectionLabel,
};
