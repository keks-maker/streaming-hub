'use strict';

// Download-Ansicht der Mediathek (rein, ohne DOM): Zustand aus downloads:list/downloads:changed, Aufteilung in Warteschlange und
// Bibliothek, Beschriftungen, Tempo/Restzeit, erlaubte Aktionen, Zustand je Folge (Symbol in der Serienliste) und die Zahlen
// für Summenzeile und Navbar-Indikator. Die IPC-Aufrufe laufen über das injizierte api (window.downloads).

const { createEmitter, safeCall } = require('./mediathek-hub-model.js');
const { sourceBadge, germanDate } = require('./mediathek-format.js');

const STATUS_LABELS = {
  queued: 'Wartet',
  resolving: 'Wird vorbereitet',
  downloading: 'Lädt',
  paused: 'Angehalten',
  scheduled: 'Zurückgestellt',
  done: 'Fertig',
  failed: 'Fehlgeschlagen',
  canceled: 'Abgebrochen',
};
const RUNNING = ['resolving', 'downloading'];
const QUEUE_RANK = { downloading: 0, resolving: 0, queued: 1, scheduled: 2, paused: 3, failed: 4, canceled: 5 };

const decimal = (value, digits) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(value);

/** "1,2 GB" / "340 MB" / "12 kB"; null bei unbekannter Größe. */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes >= 1e9) return `${decimal(bytes / 1e9, bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${decimal(bytes / 1e6, bytes >= 1e8 ? 0 : 1)} MB`;
  return `${decimal(Math.max(0, bytes) / 1e3, 0)} kB`;
}

/** "3,2 MB/s"; null ohne Wert. */
function formatSpeed(bytesPerSecond) {
  const text = typeof bytesPerSecond === 'number' && bytesPerSecond > 0 ? formatBytes(bytesPerSecond) : null;
  return text ? `${text}/s` : null;
}

/** "noch 4 Min." / "noch 1 Std. 5 Min." / "noch 30 Sek."; null ohne Wert. */
function formatEta(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  if (total < 60) return `noch ${Math.max(1, total)} Sek.`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `noch ${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  return `noch ${hours} Std. ${minutes % 60} Min.`;
}

/** "20.10.2026, 22:00 Uhr" (Europe/Berlin); null bei ungültigem Wert. */
function formatDateTime(iso) {
  const date = germanDate(iso);
  if (!date) return null;
  const time = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.parse(iso)));
  return `${date}, ${time} Uhr`;
}

const isQueueItem = view => view.status !== 'done';
const isRunning = view => RUNNING.includes(view.status);

/** Warteschlange: nicht fertige Downloads, laufende zuerst, sonst in der Reihenfolge des Einreihens. */
function queueItems(items) {
  return items
    .filter(isQueueItem)
    .sort((a, b) => QUEUE_RANK[a.status] - QUEUE_RANK[b.status] || String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** Bibliothek: fertige Downloads, zuletzt fertig zuerst. */
function libraryItems(items) {
  return items.filter(view => view.status === 'done').sort((a, b) => String(b.finishedAt || b.createdAt).localeCompare(String(a.finishedAt || a.createdAt)));
}

/** "Serie · Staffel 1 · Folge 2 · ARD" */
function subtitleOf(view) {
  const parts = [];
  if (view.seriesTitle) parts.push(view.seriesTitle);
  if (view.season) parts.push(`Staffel ${view.season}`);
  if (view.episode) parts.push(`Folge ${view.episode}`);
  parts.push(sourceBadge(view.sourceId));
  return parts.join(' · ');
}

/** Erlaubte Aktionen je Zustand (Reihenfolge = Reihenfolge der Knöpfe). */
function actionsFor(view) {
  switch (view.status) {
    case 'downloading':
    case 'resolving':
    case 'queued':
    case 'scheduled':
      return ['pause', 'cancel'];
    case 'paused':
      return ['resume', 'cancel'];
    case 'failed':
    case 'canceled':
      return ['retry', 'remove'];
    case 'done':
      return view.fileMissing ? ['remove'] : ['play', 'reveal', 'remove'];
    default:
      return [];
  }
}

const ACTION_LABELS = { pause: 'Pause', resume: 'Fortsetzen', cancel: 'Abbrechen', retry: 'Wiederholen', remove: 'Entfernen', play: 'Abspielen', reveal: 'Im Finder zeigen' };

/** Anzeige einer Zeile der Warteschlange. */
function describeQueueItem(view) {
  const percent = typeof view.progress.percent === 'number' ? Math.max(0, Math.min(100, Math.round(view.progress.percent))) : null;
  const details = [];
  let message = null;
  if (view.status === 'downloading') {
    if (percent !== null) details.push(`${percent} %`);
    const speed = formatSpeed(view.progress.speed);
    const eta = formatEta(view.progress.etaSec);
    if (speed) details.push(speed);
    if (eta) details.push(eta);
    const size = formatBytes(view.progress.bytes);
    const total = formatBytes(view.progress.totalBytes || view.estimatedBytes);
    if (size && total) details.push(`${size} von ${total}`);
  } else if (view.status === 'paused' && percent !== null) {
    details.push(`${percent} %`);
  } else if (view.status === 'queued' && view.estimatedBytes) {
    details.push(`ca. ${formatBytes(view.estimatedBytes)}`);
  }
  if (view.status === 'scheduled') {
    const when = formatDateTime(view.retryAt);
    message = view.error || 'Die Folge ist noch altersgesperrt.';
    if (when) message = `${message.replace(/\.$/, '')}. Start automatisch ab ${when}.`;
  } else if (view.status === 'failed') {
    message = view.error || 'Der Download ist fehlgeschlagen.';
  } else if (view.status === 'canceled') {
    message = 'Der Download wurde abgebrochen.';
  }
  return {
    id: view.id,
    title: view.title,
    subtitle: subtitleOf(view),
    fsk: Number.isInteger(view.fsk) ? view.fsk : null,
    status: view.status,
    statusLabel: STATUS_LABELS[view.status] || view.status,
    percent: view.status === 'downloading' || view.status === 'paused' || view.status === 'resolving' ? percent : null,
    indeterminate: view.status === 'resolving' || (view.status === 'downloading' && percent === null),
    detail: details.join(' · '),
    message,
    warnings: view.warnings || [],
    tone: view.status === 'failed' ? 'error' : view.status === 'scheduled' ? 'warn' : 'normal',
    actions: actionsFor(view),
  };
}

/** Anzeige einer Zeile der Bibliothek: Größe, Datum, „Quelle läuft ab am …“, Gesehen. */
function describeLibraryItem(view, { nowMs = Date.now() } = {}) {
  const meta = [];
  const size = formatBytes(view.fileSize);
  if (size) meta.push(size);
  const done = germanDate(view.finishedAt);
  if (done) meta.push(`geladen am ${done}`);
  const until = germanDate(view.availableUntil);
  if (until) {
    const expired = view.sourceExpired || Date.parse(view.availableUntil) < nowMs;
    meta.push(expired ? `Quelle abgelaufen am ${until}` : `Quelle läuft ab am ${until}`);
  }
  return {
    id: view.id,
    title: view.title,
    subtitle: subtitleOf(view),
    fsk: Number.isInteger(view.fsk) ? view.fsk : null,
    meta,
    watched: view.watched === undefined ? Boolean(view.watchedAt) : Boolean(view.watched),
    missing: Boolean(view.fileMissing),
    expired: Boolean(view.sourceExpired),
    actions: actionsFor(view),
  };
}

/** Summenzeile: "1 lädt · 2 wartend · 3 fertig · Frei: 120 GB". */
function summaryLine(summary, freeBytes) {
  const s = summary || {};
  const parts = [];
  if (s.active) parts.push(`${s.active} ${s.active === 1 ? 'lädt' : 'laden'}`);
  if (s.queued) parts.push(`${s.queued} wartend`);
  if (s.scheduled) parts.push(`${s.scheduled} zurückgestellt`);
  if (s.paused) parts.push(`${s.paused} angehalten`);
  if (s.failed) parts.push(`${s.failed} fehlgeschlagen`);
  if (s.done) parts.push(`${s.done} fertig`);
  if (!parts.length) parts.push('Keine Downloads');
  const free = formatBytes(freeBytes);
  if (free) parts.push(`Frei: ${free}`);
  return parts.join(' · ');
}

/** Zustand einer Folge für das Symbol in der Serienliste. */
function stateOfView(view) {
  if (!view) return { state: 'none', percent: null };
  const percent = typeof view.progress.percent === 'number' ? Math.round(view.progress.percent) : null;
  switch (view.status) {
    case 'done':
      return { state: view.fileMissing ? 'none' : 'done', percent: null };
    case 'downloading':
    case 'resolving':
      return { state: 'running', percent };
    case 'queued':
      return { state: 'queued', percent: null };
    case 'paused':
      return { state: 'paused', percent };
    case 'scheduled':
      return { state: 'scheduled', percent: null };
    case 'failed':
      return { state: 'failed', percent: null };
    default:
      return { state: 'none', percent: null }; // abgebrochen = wieder ladbar
  }
}

const STATE_LABELS = {
  none: 'Herunterladen',
  queued: 'In der Warteschlange',
  running: 'Wird geladen',
  paused: 'Angehalten',
  scheduled: 'Zurückgestellt',
  done: 'Heruntergeladen',
  failed: 'Fehlgeschlagen, erneut versuchen',
};

/** Beschriftung für Screenreader/Tooltip: "Wird geladen, 42 Prozent". */
function stateLabel({ state, percent }) {
  const base = STATE_LABELS[state] || STATE_LABELS.none;
  return percent !== null && (state === 'running' || state === 'paused') ? `${base}, ${percent} Prozent` : base;
}

/** Schlüssel, unter denen eine Folge im Index geführt sein kann (OV-/AD-Variante zählt als dieselbe Folge). */
function keysOfEntry(entry) {
  const keys = [`${entry.sourceId}:${entry.id}`];
  for (const id of [entry.originalVersionId, entry.audioDescriptionId]) if (id) keys.push(`${entry.sourceId}:${id}`);
  return keys;
}

const STATE_PRIORITY = { done: 0, running: 1, queued: 2, scheduled: 3, paused: 4, failed: 5, none: 6 };

/** Download-Zustand zu einer Folge aus der Liste aller Ansichten (bester Treffer). */
function entryState(entry, items) {
  const keys = keysOfEntry(entry);
  let best = { state: 'none', percent: null };
  let bestView = null;
  for (const view of items) {
    if (!keys.includes(view.key)) continue;
    const candidate = stateOfView(view);
    if (STATE_PRIORITY[candidate.state] < STATE_PRIORITY[best.state]) {
      best = candidate;
      bestView = view;
    }
  }
  return { ...best, view: bestView };
}

/**
 * Zustand der Downloads: Liste aus downloads:list, Ereignisse aus downloads:changed. Aktionen liefern { ok, ... } und werfen nie.
 * Der Ladevorgang ist tokenisiert (nur die jüngste Antwort zählt).
 */
function createDownloadsStore({ api }) {
  const emitter = createEmitter();
  const items = new Map();
  const state = { loaded: false, error: null, summary: {}, freeBytes: null, root: null };
  let token = 0;

  const emit = () => emitter.emit();

  async function load() {
    token += 1;
    const mine = token;
    const result = await safeCall(() => api.list());
    if (mine !== token) return;
    if (result.ok) {
      items.clear();
      for (const view of result.items || []) items.set(view.id, view);
      Object.assign(state, { loaded: true, error: null, summary: result.summary || {}, freeBytes: result.freeBytes ?? null, root: result.root || null });
    } else {
      Object.assign(state, { loaded: true, error: result.message || result.error || 'Die Downloads konnten nicht geladen werden.' });
    }
    emit();
  }

  /** Ereignis downloads:changed { items, removed, summary }. */
  function applyEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    token += 1; // eine laufende Ladeantwort wäre älter als dieses Ereignis
    for (const view of Array.isArray(payload.items) ? payload.items : []) if (view && view.id) items.set(view.id, view);
    for (const id of Array.isArray(payload.removed) ? payload.removed : []) items.delete(id);
    if (payload.summary) state.summary = payload.summary;
    state.loaded = true;
    emit();
  }

  const act = (name, ...args) => safeCall(() => api[name](...args));

  return {
    subscribe: emitter.subscribe,
    snapshot: () => state,
    load,
    applyEvent,
    all: () => [...items.values()],
    queue: () => queueItems([...items.values()]),
    library: () => libraryItems([...items.values()]),
    stateOf: entry => entryState(entry, [...items.values()]),
    /** Anzahl fertiger Downloads einer Serie. */
    downloadedCount(series) {
      let count = 0;
      for (const view of items.values()) if (view.status === 'done' && !view.fileMissing && view.seriesId === series.id && view.sourceId === series.sourceId) count += 1;
      return count;
    },
    /** Laufende und wartende Downloads (Navbar-Indikator). */
    activeCount() {
      let count = 0;
      for (const view of items.values()) if (view.status === 'queued' || isRunning(view)) count += 1;
      return count;
    },
    runningCount() {
      let count = 0;
      for (const view of items.values()) if (isRunning(view)) count += 1;
      return count;
    },
    pause: id => act('pause', id),
    resume: id => act('resume', id),
    cancel: id => act('cancel', id),
    retry: id => act('retry', id),
    remove: (id, options) => act('remove', id, options),
    reveal: id => act('reveal', id),
    playInfo: id => act('playInfo', id),
  };
}

/** Beschriftung des Navbar-Indikators; null, wenn nichts läuft. */
function indicatorLabel(active, running) {
  if (!active) return null;
  if (running === 0) return active === 1 ? 'Ein Download wartet' : `${active} Downloads warten`;
  return active === 1 ? 'Ein Download läuft' : `${active} Downloads laufen`;
}

module.exports = {
  STATUS_LABELS,
  ACTION_LABELS,
  formatBytes,
  formatSpeed,
  formatEta,
  formatDateTime,
  queueItems,
  libraryItems,
  actionsFor,
  describeQueueItem,
  describeLibraryItem,
  summaryLine,
  stateOfView,
  stateLabel,
  keysOfEntry,
  entryState,
  createDownloadsStore,
  indicatorLabel,
};
