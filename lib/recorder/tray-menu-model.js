// Tray-Menü-Modell (Etappe 2b; Konzept §3.5, E3): reine Funktion ohne Electron.
// Liefert Beschreibungen {id, label, enabled?, type?, recId?}; der TrayController
// hängt die Click-Handler an. Dadurch sind Reihenfolge, Texte und Bereinigung
// (Länge, Steuerzeichen) ohne Electron testbar.
//
// E3: Das Tray-Icon bleibt im Leerlauf violett (auch mit Planung), ROT nur bei
// laufender Aufnahme — `trayIconKind`. Geplantes erscheint nur als Menüeintrag.

'use strict';

const { sanitizeLabel } = require('./schedule-ui-model.js');
const { TRAY_WINDOW_WIDTH, clipGraphemes } = require('../radio/tray-marquee.js');

// Menüetiketten: bereinigt/gekürzt, danach "&" als "&&" maskiert (unter Windows/Linux sonst Tastenkürzel-Markierung,
// z. B. "Rock & Pop" -> "Rock Pop" mit Unterstrich); die Maskierung folgt dem Kürzen, damit kein "&&" halbiert wird.
function trayLabel(value, max) {
  return sanitizeLabel(value, max).replace(/&/g, '&&');
}
const { pendingPlans, formatPlannedTime, plannedName } = require('./planned-summary.js');

const MAX_PLANNED_ITEMS = 3;

const MAX_RADIO_TEXT = 60;
const MAX_VISIBLE_FAVORITES = 12; // darüber: „Weitere Favoriten“ als Untermenü
const VOLUME_STEP = 0.1;
const DEFAULT_TRAY_TITLE_MAX = TRAY_WINDOW_WIDTH; // Menüleiste ist knapp (Notch)

function isRadioPlaying(radio) {
  return Boolean(radio) && radio.state === 'playing';
}

/** Icon-Vorrang (R4): Aufnahme (rot) > Radio spielt (Wellen) > Leerlauf. Pause/Fehler/Laden zeigen das normale Icon. */
function trayIconKind(activeCount, radio = null) {
  if (activeCount > 0) return 'rec';
  return isRadioPlaying(radio) ? 'radio' : 'idle';
}

/** Tooltip des Tray-Icons: Aufnahme-Text unverändert, sonst Sender bei aktivem Radio. */
function trayTooltip(activeCount, radio = null) {
  if (activeCount > 0) return `Streaming Hub — ${activeCount} Aufnahme${activeCount === 1 ? '' : 'n'} laufen`;
  const name = radio && radio.station ? sanitizeLabel(radio.station.name, 40) : ''; // Tooltip: kein Menü, kein Mnemonic
  if (radio && name && (radio.state === 'playing' || radio.state === 'loading')) return `Streaming Hub — Radio: ${name}`;
  if (radio && name && radio.state === 'paused') return `Streaming Hub — Radio pausiert: ${name}`;
  return 'Streaming Hub';
}

function radioNowPlayingText(nowPlaying) {
  if (!nowPlaying) return '';
  const artist = sanitizeLabel(nowPlaying.artist, MAX_RADIO_TEXT);
  const title = sanitizeLabel(nowPlaying.title, MAX_RADIO_TEXT);
  if (artist && title) return `${artist} – ${title}`;
  return title || artist;
}

// Teilstücke ohne Maskierung; maskiert wird einmal am Ende (clip)
function radioStatusLabel(radio) {
  const name = radio.station ? sanitizeLabel(radio.station.name, 40) : '';
  const clip = text => trayLabel(text, MAX_RADIO_TEXT + 40);
  switch (radio.state) {
    case 'playing': {
      const now = radioNowPlayingText(radio.nowPlaying);
      return clip(`${name || 'Radio'}${now ? ' — ' + now : ''}`);
    }
    case 'loading':
      return clip(`${name || 'Radio'} — verbinde …`);
    case 'paused': {
      const now = radioNowPlayingText(radio.nowPlaying);
      return clip(`⏸ ${name || 'Radio'}${now ? ' — ' + now : ''}`);
    }
    case 'error': {
      const reason = sanitizeLabel(radio.error, MAX_RADIO_TEXT) || 'Stream nicht erreichbar';
      return clip(`⚠ ${name ? name + ' — ' : ''}${reason}`);
    }
    default:
      return 'Radio aus';
  }
}

/** Text neben dem Tray-Symbol (macOS `tray.setTitle`): '' = kein Text. Reine Funktion, nach Graphemen gekürzt (mit „…“); max: Infinity = ungekürzt (für den Lauftext). */
function trayTitleText(activeCount, radio, { display = 'station-title', max = DEFAULT_TRAY_TITLE_MAX } = {}) {
  if (!radio || display === 'off') return ''; // Aufnahme ändert nichts: der Text sitzt (macOS) in einem eigenen Eintrag neben dem Symbol
  const name = radio.station ? sanitizeLabel(radio.station.name, 80) : '';
  if (!name) return '';
  let text;
  if (radio.state === 'paused') text = `⏸ ${name}`;
  else if (radio.state === 'playing' || radio.state === 'loading') {
    const now = display === 'station-title' && radio.state === 'playing' ? radioNowPlayingText(radio.nowPlaying) : '';
    text = now ? `${name} · ${now}` : name;
  } else return '';
  if (max === Infinity) return text; // ungekürzt (Lauftext schneidet selbst)
  return clipGraphemes(text, Math.floor(Number(max) || DEFAULT_TRAY_TITLE_MAX));
}

function favoriteItem(fav) {
  const item = {
    id: 'radio-favorite',
    sourceId: fav.sourceId,
    stationId: fav.id,
    label: trayLabel(fav.name, 40) || 'Sender',
    type: 'checkbox',
    checked: Boolean(fav.active),
  };
  if (fav.logo) item.logo = fav.logo; // https-Adresse; der TrayController macht daraus (falls geladen) das Menü-Icon
  return item;
}

/**
 * Abschnitt „Radio“. radio: { state, station: {name}, nowPlaying: {artist, title}, error, volume (0..1), canPlayLast,
 * favorites: [{ sourceId, id, name, active, logo? }] }. Alle Texte laufen durch sanitizeLabel
 * (keine Steuerzeichen, gekürzt); Labels sind reiner Text.
 */
function buildRadioSection(radio) {
  const items = [{ id: 'radio-status', label: radioStatusLabel(radio), enabled: false }];
  const active = radio.state === 'playing' || radio.state === 'loading' || radio.state === 'paused';
  if (radio.state === 'playing' || radio.state === 'loading') items.push({ id: 'radio-pause', label: 'Pause' });
  else if (radio.state === 'paused') items.push({ id: 'radio-resume', label: 'Fortsetzen' });
  else if (radio.canPlayLast) items.push({ id: 'radio-play-last', label: 'Abspielen' });
  if (active) items.push({ id: 'radio-stop', label: 'Stopp' });
  items.push({ type: 'separator' });
  const favorites = Array.isArray(radio.favorites) ? radio.favorites : [];
  if (favorites.length) {
    items.push(...favorites.slice(0, MAX_VISIBLE_FAVORITES).map(favoriteItem));
    if (favorites.length > MAX_VISIBLE_FAVORITES) {
      items.push({ id: 'radio-favorites-more', label: 'Weitere Favoriten', submenu: favorites.slice(MAX_VISIBLE_FAVORITES).map(favoriteItem) });
    }
    if (favorites.length > 1) {
      items.push({ type: 'separator' });
      items.push({ id: 'radio-next', label: 'Nächster Favorit' });
      items.push({ id: 'radio-prev', label: 'Vorheriger Favorit' });
    }
  } else {
    items.push({ id: 'radio-favorites-empty', label: 'Keine Favoriten', enabled: false });
  }
  items.push({ type: 'separator' });
  items.push({
    id: 'radio-volume-menu',
    label: 'Lautstärke',
    submenu: [
      { id: 'radio-mute', label: 'Stumm', type: 'checkbox', checked: (Number(radio.volume) || 0) <= 0 },
      { id: 'radio-volume-up', label: 'Lauter' },
      { id: 'radio-volume-down', label: 'Leiser' },
    ],
  });
  items.push({ id: 'radio-open', label: 'Radio-Dashboard öffnen' });
  return items;
}

/**
 * options:
 * - jobs: [{ recId, channelName, channelId, epgTitle, elapsedText }] laufende Aufnahmen
 * - planned: Planungseinträge (alle; gefiltert wird hier), nowMs
 * - hasStorageRoot, hasLibrary, hasPlanning: Aktionen anbieten
 * - radio: optional, Abschnitt „Radio“ (siehe buildRadioSection); ohne Angabe bleibt das Menü unverändert
 */
function buildTrayMenuModel({ jobs = [], planned = [], nowMs, hasStorageRoot = false, hasLibrary = false, hasPlanning = false, radio = null } = {}) {
  const items = [];
  for (const job of jobs) {
    const channel = trayLabel(job.channelName || job.channelId || 'Kanal', 40) || 'Kanal';
    const title = trayLabel(job.epgTitle, 60);
    items.push({
      id: 'job',
      recId: job.recId,
      label: `● ${channel}${title ? ' — ' + title : ''} · ${job.elapsedText}`,
      enabled: false, // reine Statuszeile
    });
    items.push({ id: 'job-stop', recId: job.recId, label: '  ⏹ Aufnahme stoppen' });
  }
  if (jobs.length) items.push({ type: 'separator' });

  if (radio) {
    items.push(...buildRadioSection(radio), { type: 'separator' });
  }

  const plans = pendingPlans(planned, nowMs);
  if (plans.length) {
    for (const plan of plans.slice(0, MAX_PLANNED_ITEMS)) {
      items.push({
        id: 'planned',
        entryId: plan.entry.id,
        label: `Geplant: ${plannedName(plan.entry)} · ${formatPlannedTime(plan.startMs, nowMs)}`,
        enabled: false,
      });
    }
    if (plans.length > MAX_PLANNED_ITEMS) {
      items.push({ id: 'planned-more', label: `… und ${plans.length - MAX_PLANNED_ITEMS} weitere geplant`, enabled: false });
    }
  }
  if (hasPlanning) items.push({ id: 'open-planning', label: 'Planung öffnen' });
  if (plans.length || hasPlanning) items.push({ type: 'separator' });

  if (hasStorageRoot) items.push({ id: 'open-folder', label: 'Aufnahmen-Ordner öffnen' });
  items.push({ id: 'open-app', label: 'App öffnen' });
  if (hasLibrary) items.push({ id: 'open-library', label: 'Aufnahmen-Bibliothek' });
  items.push({ type: 'separator' });
  items.push(jobs.length ? { id: 'quit-confirm', label: 'Beenden …' } : { id: 'quit', label: 'Beenden' });
  return items;
}

module.exports = {
  buildTrayMenuModel,
  trayIconKind,
  trayTooltip,
  trayTitleText,
  buildRadioSection,
  MAX_PLANNED_ITEMS,
  MAX_VISIBLE_FAVORITES,
  VOLUME_STEP,
  DEFAULT_TRAY_TITLE_MAX,
};
