'use strict';

// Kapitelmarken (Podcasting 2.0 JSON-Chapters, Podlove Simple Chapters): reine Funktionen ohne Netz und DOM.
// Ergebnis ist immer [{ start (Sekunden), title }], aufsteigend nach Start, ohne doppelte Startzeiten, höchstens 200 Kapitel.
// Titel sind reiner Text (Steuerzeichen entfernt, gekürzt); Links und Bilder der Kapitel werden bewusst nicht übernommen.

const MAX_CHAPTERS = 200;
const MAX_TITLE = 200;
const MAX_START_SECONDS = 48 * 3600;
const MAX_JSON_CHARS = 1024 * 1024;

// eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das Ziel
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1).trimEnd()}…` : text;
}

/** "H:MM:SS(.fff)", "MM:SS", "SS(.fff)" oder Zahl -> Sekunden (>= 0), sonst null. NPT-Präfix "npt:" wird toleriert. */
function parseTimecode(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && value <= MAX_START_SECONDS ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^npt:/i, '').replace(',', '.');
  if (!text) return null;
  let seconds = null;
  if (/^\d+(?:\.\d+)?$/.test(text)) seconds = Number(text);
  else if (/^\d{1,3}(?::\d{1,2}){1,2}(?:\.\d+)?$/.test(text)) seconds = text.split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
  return seconds !== null && Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_START_SECONDS ? seconds : null;
}

/** Rohliste [{ start (Zahl oder Zeitangabe), title }] -> bereinigte, sortierte Kapitelliste. */
function normalizeChapters(list) {
  if (!Array.isArray(list)) return [];
  const byStart = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const start = parseTimecode(entry.start);
    const title = cleanTitle(entry.title);
    if (start === null || !title) continue;
    const key = Math.round(start * 10) / 10;
    if (!byStart.has(key)) byStart.set(key, { start: key, title });
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start).slice(0, MAX_CHAPTERS);
}

/** JSON-Chapters (Podcasting 2.0): { version, chapters: [{ startTime, title, toc? }] } oder direkt ein Array. Wirft bei ungültigem JSON. */
function parseChaptersJson(text) {
  if (typeof text !== 'string' || text.length > MAX_JSON_CHARS) throw new Error('Kapitel-Datei ist zu groß');
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Kapitel-Datei ist kein gültiges JSON');
  }
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? data.chapters : null;
  if (!Array.isArray(list)) throw new Error('Kapitel-Datei enthält keine Kapitel');
  return normalizeChapters(list.slice(0, MAX_CHAPTERS * 2).filter(entry => entry && entry.toc !== false).map(entry => ({ start: entry.startTime !== undefined ? entry.startTime : entry.start_time, title: entry.title })));
}

/**
 * Aktuelles Kapitel zur Position: das letzte Kapitel mit start <= position. Liefert { index, chapter } oder null
 * (leere Liste oder Position vor dem ersten Kapitel).
 */
function currentChapter(chapters, position) {
  if (!Array.isArray(chapters) || !chapters.length || !Number.isFinite(position)) return null;
  let found = -1;
  for (let i = 0; i < chapters.length; i += 1) {
    if (chapters[i].start <= position + 0.25) found = i;
    else break;
  }
  return found < 0 ? null : { index: found, chapter: chapters[found] };
}

module.exports = { MAX_CHAPTERS, MAX_TITLE, MAX_JSON_CHARS, parseTimecode, normalizeChapters, parseChaptersJson, currentChapter, cleanTitle };
