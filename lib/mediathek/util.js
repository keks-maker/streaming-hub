'use strict';

// Kleine, reine Helfer der Mediathek-Parser (Port von MediathekParser.swift): alle Felder der Sender-APIs sind unsicher,
// falsche Typen ergeben leere Werte statt Abbruch.

/** Nur Objekt-Elemente eines Arrays behalten; alles andere ergibt []. */
function dicts(value) {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Getrimmter Text oder null bei Nicht-String/leer. */
function nonEmpty(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
}

/** Endliche Zahl oder null (Strings und Booleans zählen nicht). */
function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** ISO-8601-Text als ISO-String in UTC (Millisekunden entfallen nicht); null bei ungültigem Datum. */
function isoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** Kalendertag (YYYY-MM-DD) in Europe/Berlin zu einem ISO-Zeitpunkt; null bei ungültigem Datum. */
function berlinDay(value) {
  const iso = isoDate(value);
  if (!iso) return null;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** Entfernt Einträge mit bereits gesehener id (Reihenfolge bleibt). */
function dedupe(entries) {
  const seen = new Set();
  return entries.filter(entry => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

/** Ergänzt/ersetzt Felder eines Eintrags (Einträge sind unveränderlich gedacht). */
function withFields(entry, fields) {
  return { ...entry, ...fields };
}

const FSK_LEVELS = new Set([0, 6, 12, 16, 18]);

/**
 * Altersfreigabe als Zahl (0/6/12/16/18) aus Texten wie "FSK12", "fsk 16", "ab 12", "16" oder aus einer Zahl; null bei
 * "none", "NONE", leer oder unbekannten Stufen. Objekte mit code/label/value werden nach diesen Feldern gelesen.
 */
function fskLevel(value) {
  if (isObject(value)) return fskLevel(value.code ?? value.value ?? value.label ?? null);
  if (typeof value === 'number') return FSK_LEVELS.has(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = /(?:^|\D)(\d{1,2})(?!\d)/.exec(value);
  const level = match ? Number(match[1]) : null;
  return level !== null && FSK_LEVELS.has(level) ? level : null;
}

/** Erzeugt einen Eintrag mit allen Feldern des Apple-Modells (fehlende Werte null, regionRestricted false). */
function makeEntry(fields) {
  return {
    id: fields.id,
    title: fields.title,
    subtitle: fields.subtitle ?? null,
    description: fields.description ?? null,
    streamUrl: fields.streamUrl ?? null,
    imageUrl: fields.imageUrl ?? null,
    duration: fields.duration ?? null,
    sourceId: fields.sourceId,
    airedAt: fields.airedAt ?? null,
    partner: fields.partner ?? null,
    season: fields.season ?? null,
    episode: fields.episode ?? null,
    regionRestricted: fields.regionRestricted === true,
    originalVersionId: fields.originalVersionId ?? null,
    audioDescriptionId: fields.audioDescriptionId ?? null,
    availableUntil: fields.availableUntil ?? null,
    fsk: fskLevel(fields.fsk),
  };
}

function makeSeries(fields) {
  return {
    id: fields.id,
    title: fields.title,
    imageUrl: fields.imageUrl ?? null,
    description: fields.description ?? null,
    sourceId: fields.sourceId,
    groupingURL: fields.groupingURL,
  };
}

function makeSection({ title, entries = [], series = [], genres = [], nextPage = null }) {
  return { title, entries, series, genres, nextPage };
}

module.exports = { dicts, isObject, nonEmpty, number, isoDate, berlinDay, fskLevel, dedupe, withFields, makeEntry, makeSeries, makeSection };
