'use strict';

// Serien-Abos „Neue Folgen automatisch laden“ (rein, ohne DOM): Zustand aus subscriptions:list/subscriptions:changed, Beschriftungen
// für die Ansicht „Abos“ (zuletzt geprüft, Ergebnis, nächste Prüfung, Optionen) und Meldungen der Aktionen. Die IPC-Aufrufe laufen
// über das injizierte api (window.downloads.subscriptions).

const { createEmitter, safeCall } = require('./mediathek-hub-model.js');
const { sourceBadge } = require('./mediathek-format.js');
const { formatDateTime } = require('./mediathek-downloads-model.js');

const MODE_OPTIONS = [
  { id: 'future', label: 'Nur künftige Folgen', hint: 'Die vorhandenen Folgen gelten als bekannt. Geladen wird, was danach neu erscheint.' },
  { id: 'all', label: 'Auch bereits vorhandene Folgen laden', hint: 'Du wählst gleich die Folgen aus, die jetzt geladen werden. Danach zählt nur noch Neues.' },
];

const RESULT_TONES = { ok: 'normal', offline: 'warn', error: 'error', space: 'warn', storage: 'error' };
const HEIGHT_LABELS = { best: 'Beste Qualität', 1080: 'Bis 1080p', 720: 'Bis 720p', 540: 'Bis 540p', 360: 'Bis 360p' };
const AUDIO_LABELS = { preferred: 'bevorzugte Tonspur', all: 'alle Tonspuren' };
const SUBTITLE_LABELS = { none: 'ohne Untertitel', preferred: 'Untertitel', all: 'alle Untertitel' };

const plural = (n, one, many) => (n === 1 ? one : many);

/** "gerade eben" / "vor 5 Min." / "vor 3 Std." / "20.10.2026, 22:00 Uhr"; null ohne Zeitpunkt. */
function relativeTime(iso, nowMs = Date.now()) {
  const time = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(time)) return null;
  const minutes = Math.floor((nowMs - time) / 60000);
  if (minutes < 1) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} Min.`;
  if (minutes < 24 * 60) return `vor ${Math.floor(minutes / 60)} Std.`;
  return formatDateTime(iso);
}

/** "in 5 Min." / "in 3 Std." / "20.10.2026, 22:00 Uhr"; null ohne Zeitpunkt. */
function untilTime(iso, nowMs = Date.now()) {
  const time = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(time)) return null;
  const minutes = Math.ceil((time - nowMs) / 60000);
  if (minutes <= 1) return 'in Kürze';
  if (minutes < 60) return `in ${minutes} Min.`;
  if (minutes < 24 * 60) return `in ${Math.round(minutes / 60)} Std.`;
  return formatDateTime(iso);
}

/** Kurzbeschreibung der abweichenden Download-Optionen eines Abos; „Standard“, wenn keine gesetzt sind. */
function overridesSummary(overrides) {
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const parts = [];
  if (o.maxHeight) parts.push(HEIGHT_LABELS[o.maxHeight] || o.maxHeight);
  if (o.container) parts.push(String(o.container).toUpperCase());
  if (o.audioMode) parts.push(AUDIO_LABELS[o.audioMode] || o.audioMode);
  if (o.audioDescription && o.audioDescription !== 'never') parts.push('mit Audiodeskription');
  if (o.subtitleMode) parts.push(SUBTITLE_LABELS[o.subtitleMode] || o.subtitleMode);
  return parts.length ? parts.join(', ') : 'Standard (globale Download-Einstellungen)';
}

/** Anzeige einer Zeile in der Ansicht „Abos“. */
function describeSubscription(view, { nowMs = Date.now(), globalEnabled = true } = {}) {
  const result = view.lastResult;
  const checked = view.lastCheckAt ? relativeTime(view.lastCheckAt, nowMs) : null;
  let resultText = 'Noch nicht geprüft.';
  let tone = 'normal';
  if (result) {
    resultText = result.message || 'Geprüft.';
    tone = RESULT_TONES[result.status] || 'normal';
  }
  const notes = [];
  if (result && result.note) notes.push(result.note);
  if (view.note && view.note !== (result && result.note)) notes.push(view.note);
  if (!view.enabled) {
    resultText = 'Pausiert. Es werden keine neuen Folgen geladen.';
    tone = 'normal';
  } else if (!globalEnabled) {
    notes.push('Automatisches Laden ist in den Einstellungen ausgeschaltet.');
  }
  return {
    id: view.id,
    title: view.title,
    subtitle: `${sourceBadge(view.sourceId)} · Serie`,
    enabled: Boolean(view.enabled),
    checkedText: checked ? `Zuletzt geprüft: ${checked}` : 'Zuletzt geprüft: noch nie',
    resultText,
    tone,
    notes,
    optionsText: overridesSummary(view.overrides),
    hasOverrides: Boolean(view.overrides && Object.keys(view.overrides).length),
  };
}

/** Zeile über der Liste: nächste Prüfung, Intervall, Zustand. */
function headline(snapshot, { nowMs = Date.now() } = {}) {
  if (!snapshot.enabled) return 'Automatisches Laden ist ausgeschaltet (Einstellungen ▸ Mediatheken ▸ Downloads ▸ Steuerung).';
  if (snapshot.checking) return 'Die Abos werden gerade geprüft …';
  const active = [...snapshot.items].filter(item => item.enabled).length;
  if (!active) return 'Keine aktiven Abos.';
  const next = untilTime(snapshot.nextCheckAt, nowMs);
  const every = snapshot.intervalHours === 1 ? 'jede Stunde' : `alle ${snapshot.intervalHours} Stunden`;
  return [`${active} ${plural(active, 'aktives Abo', 'aktive Abos')}`, `Prüfung ${every}`, next ? `nächste ${next}` : null, 'Die App muss dafür laufen'].filter(Boolean).join(' · ');
}

/** Meldung nach dem Anlegen eines Abos (Antwort von subscriptions:add). */
function addResultText(result, title) {
  if (result && result.ok) return `Neue Folgen von ${title} werden automatisch geladen.`;
  return `Das Abo konnte nicht angelegt werden: ${(result && (result.message || result.error)) || 'Unbekannter Fehler'}`;
}

/** Meldung nach „Jetzt prüfen“ (Antwort von subscriptions:check-now). */
function checkResultText(result) {
  if (!result || result.ok === false) return `Prüfung nicht möglich: ${(result && (result.message || result.error)) || 'Unbekannter Fehler'}`;
  if (!result.added) return result.checked === 1 ? 'Keine neuen Folgen.' : `${result.checked} ${plural(result.checked, 'Abo', 'Abos')} geprüft, keine neuen Folgen.`;
  return `${result.added} ${plural(result.added, 'neue Folge wird', 'neue Folgen werden')} geladen.`;
}

/**
 * Zustand der Abos: Liste aus subscriptions:list, Ereignisse aus subscriptions:changed. Aktionen liefern { ok, ... } und werfen nie.
 * Der Ladevorgang ist tokenisiert (nur die jüngste Antwort zählt).
 */
function createSubscriptionsStore({ api }) {
  const emitter = createEmitter();
  const state = { loaded: false, error: null, items: [], checking: false, enabled: true, intervalHours: 6, nextCheckAt: null };
  let token = 0;

  function apply(payload) {
    state.items = Array.isArray(payload.items) ? payload.items.filter(item => item && item.id) : [];
    state.checking = payload.checking === true;
    state.enabled = payload.enabled !== false;
    state.intervalHours = Number.isInteger(payload.intervalHours) ? payload.intervalHours : state.intervalHours;
    state.nextCheckAt = payload.nextCheckAt || null;
    state.loaded = true;
    state.error = null;
  }

  async function load() {
    token += 1;
    const mine = token;
    const result = await safeCall(() => api.list());
    if (mine !== token) return;
    if (result.ok) apply(result);
    else Object.assign(state, { loaded: true, error: result.message || result.error || 'Die Abos konnten nicht geladen werden.' });
    emitter.emit();
  }

  /** Ereignis subscriptions:changed (Inhalt wie die Liste). */
  function applyEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    token += 1;
    apply(payload);
    emitter.emit();
  }

  const find = series => state.items.find(item => item.sourceId === series.sourceId && item.seriesId === series.id) || null;
  const act = (name, ...args) => safeCall(() => api[name](...args));

  return {
    subscribe: emitter.subscribe,
    snapshot: () => state,
    load,
    applyEvent,
    all: () => state.items,
    find,
    isSubscribed: series => Boolean(find(series)),
    /** Anzahl der Abos, die gerade laden dürfen (Badge/Zähler). */
    activeCount: () => state.items.filter(item => item.enabled).length,
    add: input => act('add', input),
    update: input => act('update', input),
    remove: id => act('remove', id),
    checkNow: id => act('checkNow', id),
  };
}

module.exports = {
  MODE_OPTIONS,
  relativeTime,
  untilTime,
  overridesSummary,
  describeSubscription,
  headline,
  addResultText,
  checkResultText,
  createSubscriptionsStore,
};
