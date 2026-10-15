'use strict';

// Einstellungen → Podcasts → Wiedergabe (P4): Standardgeschwindigkeit, Sprungweiten (zurück/vor), „nach Ende nächste Episode
// abspielen“, Prüfintervall der Feeds, automatisch „gehört“ ab 95 % und die eigene Lautstärke der Podcasts. Alles wird sofort
// über podcast:set-settings gespeichert (Lautstärke über podcast:volume, die sie mitspeichert). Hinweis: „Beim Schließen des
// Fensters weiterspielen“ und „bei Bildwiedergabe pausieren“ sind gemeinsame Radio-Einstellungen und gelten auch für Podcasts.

const { el, statusLine, setStatus, button, formatIpcError } = require('./settings-radio-dom.js');
const { SKIP_VALUES, REFRESH_INTERVAL_VALUES, RATE_VALUES, DEFAULT_PODCAST_SETTINGS } = require('./lib/podcast/podcast-settings.js');
const { rateLabel } = require('./radio-miniplayer-model.js');

const FLAGS = [
  {
    key: 'autoPlayNext',
    label: 'Nach dem Ende die nächste Episode abspielen',
    hint: 'Es folgt die nächste ungehörte Episode derselben Sendung, von der ältesten zur neuesten. Ohne weitere ungehörte Episode endet die Wiedergabe.',
  },
  {
    key: 'autoMarkPlayed',
    label: 'Episoden ab 95 % automatisch als gehört markieren',
    hint: 'Ist die Option aus, markierst du Episoden selbst als gehört. Ein begonnener Fortschritt wird trotzdem gemerkt.',
  },
];

function secondsLabel(value) {
  return `${value} Sekunden`;
}

function intervalLabel(value) {
  return value === 60 ? 'Jede Stunde (60 Minuten)' : value === 120 ? 'Alle 2 Stunden (120 Minuten)' : `Alle ${value} Minuten`;
}

/** options: { podcasts (window.podcasts, mit .player), logger, onOpenRadioPlayback() (springt zu Radio → Wiedergabe) } */
function createPodcastPlaybackView(root, { podcasts, logger = null, onOpenRadioPlayback = null } = {}) {
  const doc = root.ownerDocument || document;
  const state = { settings: null, volume: null };

  function selectRow(id, field, labelText, values, labelOf, hintText) {
    const row = el(doc, 'div', 'settings-row');
    const label = el(doc, 'label', 'settings-row-label', labelText);
    label.setAttribute('for', id);
    const select = el(doc, 'select');
    select.id = id;
    select.dataset.field = field;
    for (const value of values) {
      const option = el(doc, 'option', '', labelOf(value));
      option.value = String(value);
      select.appendChild(option);
    }
    row.append(label, select);
    const hint = hintText ? el(doc, 'p', 'settings-field-hint', hintText) : null;
    if (hint) {
      hint.id = `${id}-hint`;
      select.setAttribute('aria-describedby', hint.id);
    }
    select.addEventListener('change', () => save(field, Number(select.value), select));
    return { row, hint, select };
  }

  const rate = selectRow('settingsPodcastRate', 'rate', 'Standardgeschwindigkeit', RATE_VALUES, rateLabel, 'Jede neu gestartete Episode beginnt mit dieser Geschwindigkeit; im Mini-Player lässt sie sich für die laufende Episode ändern.');
  const back = selectRow('settingsPodcastSkipBack', 'skipBack', 'Sprung zurück', SKIP_VALUES, secondsLabel);
  const forward = selectRow('settingsPodcastSkipForward', 'skipForward', 'Sprung vor', SKIP_VALUES, secondsLabel, 'Gilt für den Mini-Player, das Tray-Menü, die Medientasten und „Läuft gerade“.');
  const interval = selectRow('settingsPodcastInterval', 'refreshIntervalMinutes', 'Auf neue Episoden prüfen', REFRESH_INTERVAL_VALUES, intervalLabel, 'Zusätzlich zur Prüfung beim Start, solange die App läuft. Feeds ohne Änderungsangabe werden höchstens in diesem Abstand geladen.');

  const volumeRow = el(doc, 'div', 'settings-row');
  const volumeLabel = el(doc, 'label', 'settings-row-label', 'Lautstärke');
  volumeLabel.setAttribute('for', 'settingsPodcastVolume');
  const slider = el(doc, 'input', 'settings-radio-volume');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.id = 'settingsPodcastVolume';
  slider.dataset.field = 'volume';
  const output = el(doc, 'output', 'settings-radio-volume-value', '');
  output.id = 'settingsPodcastVolumeValue';
  volumeRow.append(volumeLabel, slider, output);
  const volumeHint = el(doc, 'p', 'settings-field-hint', 'Eigene Lautstärke der Podcasts, unabhängig vom Radio. Sie bleibt beim nächsten Start erhalten.');

  const checks = new Map();
  const flagHost = el(doc, 'div', 'settings-row settings-row-stack');
  for (const flag of FLAGS) {
    const label = el(doc, 'label', 'tv-mode-label');
    const input = el(doc, 'input');
    input.type = 'checkbox';
    input.id = `settingsPodcast-${flag.key}`;
    input.dataset.field = flag.key;
    label.append(input, el(doc, 'span', '', ` ${flag.label}`));
    const hint = el(doc, 'p', 'settings-field-hint', flag.hint);
    hint.id = `${input.id}-hint`;
    input.setAttribute('aria-describedby', hint.id);
    flagHost.append(label, hint);
    checks.set(flag.key, input);
    input.addEventListener('change', () => save(flag.key, input.checked, input));
  }

  const sharedNote = el(doc, 'div', 'settings-row settings-row-stack');
  sharedNote.id = 'settingsPodcastSharedNote';
  sharedNote.appendChild(
    el(
      doc,
      'p',
      'settings-field-hint',
      'Gemeinsam mit dem Radio: „Beim Schließen des Fensters weiterspielen“ (die App läuft dann im Tray weiter) und „Pausieren, wenn LiveTV, ein Streamingdienst oder eine Aufnahme startet“ gelten auch für Podcasts. Du findest beides unter Radio → Wiedergabe.',
    ),
  );
  if (typeof onOpenRadioPlayback === 'function') {
    const open = button(doc, 'settings-action-btn', 'Radio-Wiedergabe öffnen', 'open-radio-playback');
    open.id = 'settingsPodcastOpenRadioPlayback';
    open.addEventListener('click', onOpenRadioPlayback);
    sharedNote.appendChild(open);
  }

  const statusEl = statusLine(doc, 'settingsPodcastPlaybackStatus');
  root.textContent = '';
  root.append(rate.row, rate.hint, back.row, forward.row, forward.hint, flagHost, interval.row, interval.hint, volumeRow, volumeHint, sharedNote, statusEl);

  const showVolume = value => {
    const percent = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100);
    slider.value = String(percent);
    slider.setAttribute('aria-valuetext', `${percent} Prozent`);
    output.textContent = `${percent} %`;
  };

  function show(settings) {
    const next = { ...DEFAULT_PODCAST_SETTINGS, ...settings };
    state.settings = next;
    rate.select.value = String(next.rate);
    back.select.value = String(next.skipBack);
    forward.select.value = String(next.skipForward);
    interval.select.value = String(next.refreshIntervalMinutes);
    for (const [key, input] of checks) input.checked = Boolean(next[key]);
    if (state.volume === null) showVolume(next.volume);
  }

  async function save(key, value, control) {
    try {
      show(await podcasts.setSettings({ [key]: value }));
      setStatus(statusEl, '✓ Gespeichert');
    } catch (error) {
      if (state.settings) show(state.settings); // Anzeige auf den gespeicherten Stand zurück
      else if (control && control.type === 'checkbox') control.checked = !value;
      setStatus(statusEl, formatIpcError(error) || 'Einstellung konnte nicht gespeichert werden', true);
    }
  }

  slider.addEventListener('input', () => {
    output.textContent = `${slider.value} %`;
    slider.setAttribute('aria-valuetext', `${slider.value} Prozent`);
  });
  slider.addEventListener('change', async () => {
    try {
      await podcasts.player.setVolume(Number(slider.value) / 100);
      setStatus(statusEl, '✓ Gespeichert');
    } catch (error) {
      setStatus(statusEl, formatIpcError(error) || 'Lautstärke konnte nicht gespeichert werden', true);
    }
  });

  async function refresh() {
    try {
      state.volume = null;
      show(await podcasts.getSettings());
      if (podcasts.player && podcasts.player.getState) {
        const playerState = await podcasts.player.getState();
        if (playerState && typeof playerState.volume === 'number') {
          state.volume = playerState.volume;
          showVolume(playerState.volume);
        }
      }
    } catch (error) {
      if (logger) logger.warn('Podcast-Einstellungen konnten nicht geladen werden', error && error.message);
      setStatus(statusEl, 'Einstellungen konnten nicht geladen werden', true);
    }
  }

  const unsubscribers = [];
  if (typeof podcasts.onSettingsChanged === 'function') {
    unsubscribers.push(podcasts.onSettingsChanged(next => next && show(next)));
  }
  // Lautstärke folgt dem Mini-Player, solange der Regler nicht gerade bedient wird
  if (podcasts.player && typeof podcasts.player.onState === 'function') {
    unsubscribers.push(
      podcasts.player.onState(next => {
        if (next && typeof next.volume === 'number' && (!doc.activeElement || doc.activeElement !== slider)) {
          state.volume = next.volume;
          showVolume(next.volume);
        }
      }),
    );
  }

  return { refresh, getState: () => state, dispose: () => unsubscribers.forEach(off => typeof off === 'function' && off()) };
}

module.exports = { createPodcastPlaybackView, FLAGS };
