'use strict';

// Einstellungen → Radio → Wiedergabe (R3): Lautstärke (gilt auch als Start-Lautstärke), „Beim Start letzten Sender
// fortsetzen“, Radio bei Bildwiedergabe pausieren (pauseOnTv) und Verhalten beim Schließen des Fensters. Die Schalter
// laufen über radio:set-settings, die Lautstärke über radio:set-volume (wird dabei gespeichert).

const { el, statusLine, setStatus, formatIpcError } = require('./settings-radio-dom.js');

const OPTIONS = [
  {
    key: 'resumeOnStart',
    label: 'Beim Start letzten Sender fortsetzen',
    hint: 'Das Radio beginnt beim Start der App von selbst zu spielen. Ist die Option aus, startet es nie ohne dein Zutun.',
  },
  {
    key: 'pauseOnTv',
    label: 'Radio pausieren, wenn LiveTV, ein Streamingdienst oder eine Aufnahme startet',
    hint: 'Verhindert doppelten Ton. Das Radio wird nicht automatisch fortgesetzt.',
  },
  {
    key: 'keepPlayingWhenClosed',
    label: 'Beim Schließen des Fensters weiterspielen',
    hint: 'Die App läuft dann im Tray weiter und das Radio spielt weiter. Das setzt ein Tray-Symbol voraus – ohne Tray wird die App beim Schließen beendet.',
  },
];

// Anzeige neben dem Tray-Symbol (nur macOS-Menüleiste); Standard „Sender und Titel“
const TRAY_SCROLL_MODE_OPTIONS = [
  { value: 'smooth', label: 'Flüssig' },
  { value: 'steps', label: 'Schrittweise' },
];
const DEFAULT_TRAY_SCROLL_MODE = 'smooth';

const TRAY_DISPLAY_OPTIONS = [
  { value: 'station', label: 'Nur Sender' },
  { value: 'station-title', label: 'Sender und Titel' },
  { value: 'off', label: 'Aus' },
];
const DEFAULT_TRAY_DISPLAY = 'station-title';

function createRadioPlaybackView(root, { radio, logger = null } = {}) {
  const doc = root.ownerDocument || document;
  const state = { settings: null, volume: null };

  const volumeRow = el(doc, 'div', 'settings-row');
  const volumeLabel = el(doc, 'label', 'settings-row-label', 'Lautstärke');
  volumeLabel.setAttribute('for', 'settingsRadioVolume');
  const slider = el(doc, 'input', 'settings-radio-volume');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.id = 'settingsRadioVolume';
  slider.dataset.field = 'volume';
  const output = el(doc, 'output', 'settings-radio-volume-value', '');
  output.id = 'settingsRadioVolumeValue';
  volumeRow.append(volumeLabel, slider, output);
  const volumeHint = el(doc, 'p', 'settings-field-hint', 'Gilt sofort und bleibt als Lautstärke beim nächsten Start erhalten.');

  const checks = new Map();
  const optionHost = el(doc, 'div', 'settings-row settings-row-stack');
  for (const option of OPTIONS) {
    const label = el(doc, 'label', 'tv-mode-label');
    const input = el(doc, 'input');
    input.type = 'checkbox';
    input.id = `settingsRadio-${option.key}`;
    input.dataset.field = option.key;
    label.appendChild(input);
    label.appendChild(el(doc, 'span', '', ` ${option.label}`));
    const hint = el(doc, 'p', 'settings-field-hint', option.hint);
    hint.id = `${input.id}-hint`;
    input.setAttribute('aria-describedby', hint.id);
    optionHost.append(label, hint);
    checks.set(option.key, input);
    input.addEventListener('change', () => saveFlag(option.key, input));
  }

  // Anzeige neben dem Symbol: Radiobuttons (eine Auswahl), Speichern über radio:set-settings
  const displayGroup = el(doc, 'fieldset', 'settings-row settings-row-stack settings-radio-group');
  displayGroup.id = 'settingsRadio-trayDisplay';
  displayGroup.appendChild(el(doc, 'legend', 'settings-row-label', 'Anzeige neben dem Symbol'));
  const displayHint = el(doc, 'p', 'settings-field-hint', 'Zeigt in der Menüleiste (macOS) neben dem Symbol den laufenden Sender und auf Wunsch den Titel. Bei einer laufenden Aufnahme erscheint kein Radiotext.');
  displayHint.id = 'settingsRadio-trayDisplay-hint';
  displayGroup.setAttribute('aria-describedby', displayHint.id);
  const displayRadios = new Map();
  for (const option of TRAY_DISPLAY_OPTIONS) {
    const label = el(doc, 'label', 'tv-mode-label');
    const input = el(doc, 'input');
    input.type = 'radio';
    input.name = 'settingsRadio-trayDisplay';
    input.value = option.value;
    input.id = `settingsRadio-trayDisplay-${option.value}`;
    input.dataset.field = 'trayDisplay';
    label.appendChild(input);
    label.appendChild(el(doc, 'span', '', ` ${option.label}`));
    displayGroup.appendChild(label);
    displayRadios.set(option.value, input);
    input.addEventListener('change', () => {
      if (input.checked) saveTrayDisplay(option.value);
    });
  }
  // Lauftext: lange Texte durchlaufen lassen (bei „Aus“ ohne Wirkung, daher deaktiviert)
  const scrollLabel = el(doc, 'label', 'tv-mode-label');
  const scrollInput = el(doc, 'input');
  scrollInput.type = 'checkbox';
  scrollInput.id = 'settingsRadio-trayScroll';
  scrollInput.dataset.field = 'trayScroll';
  scrollLabel.appendChild(scrollInput);
  scrollLabel.appendChild(el(doc, 'span', '', ' Lange Texte durchlaufen lassen'));
  const scrollHint = el(doc, 'p', 'settings-field-hint', 'Zu lange Texte laufen langsam durch, damit man alles lesen kann. Ist die Option aus oder in macOS „Bewegung reduzieren“ aktiv, wird der Text gekürzt und mit „…“ beendet.');
  scrollHint.id = 'settingsRadio-trayScroll-hint';
  scrollInput.setAttribute('aria-describedby', scrollHint.id);
  scrollInput.addEventListener('change', () => saveFlag('trayScroll', scrollInput));
  // Art des Durchlaufs: „Flüssig“ (pixelweise, als Bild) oder „Schrittweise“ (zeichenweise, wie ein Text; ruckelt systembedingt)
  const modeRow = el(doc, 'label', 'tv-mode-label');
  const modeSelect = el(doc, 'select');
  modeSelect.id = 'settingsRadio-trayScrollMode';
  modeSelect.dataset.field = 'trayScrollMode';
  for (const option of TRAY_SCROLL_MODE_OPTIONS) {
    const item = el(doc, 'option', '', option.label);
    item.value = option.value;
    modeSelect.appendChild(item);
  }
  modeRow.append(el(doc, 'span', '', 'Durchlauf: '), modeSelect);
  const modeHint = el(doc, 'p', 'settings-field-hint', '„Flüssig“ verschiebt den Text pixelweise. „Schrittweise“ springt zeichenweise und wirkt unruhiger, braucht aber kein Textbild.');
  modeHint.id = 'settingsRadio-trayScrollMode-hint';
  modeSelect.setAttribute('aria-describedby', modeHint.id);
  modeSelect.addEventListener('change', () => saveTrayScrollMode(modeSelect.value));
  displayGroup.append(scrollLabel, scrollHint, modeRow, modeHint);
  displayGroup.appendChild(displayHint);
  const statusEl = statusLine(doc, 'settingsRadioPlaybackStatus');
  root.textContent = '';
  root.append(volumeRow, volumeHint, optionHost, displayGroup, statusEl);

  const showVolume = value => {
    const percent = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100);
    slider.value = String(percent);
    slider.setAttribute('aria-valuetext', `${percent} Prozent`);
    output.textContent = `${percent} %`;
  };

  function showTrayDisplay(value) {
    const current = displayRadios.has(value) ? value : DEFAULT_TRAY_DISPLAY;
    for (const [optionValue, input] of displayRadios) input.checked = optionValue === current;
    scrollInput.disabled = current === 'off';
    modeSelect.disabled = current === 'off' || !scrollInput.checked;
  }

  async function saveTrayScrollMode(wanted) {
    try {
      show(await radio.setSettings({ trayScrollMode: wanted }));
      setStatus(statusEl, '✓ Gespeichert');
    } catch (error) {
      modeSelect.value = state.settings && state.settings.trayScrollMode ? state.settings.trayScrollMode : DEFAULT_TRAY_SCROLL_MODE;
      setStatus(statusEl, formatIpcError(error), true);
    }
  }

  async function saveTrayDisplay(wanted) {
    try {
      show(await radio.setSettings({ trayDisplay: wanted }));
      setStatus(statusEl, '✓ Gespeichert');
    } catch (error) {
      showTrayDisplay(state.settings && state.settings.trayDisplay);
      setStatus(statusEl, formatIpcError(error), true);
    }
  }

  function show(settings) {
    state.settings = settings;
    for (const [key, input] of checks) input.checked = Boolean(settings[key]);
    scrollInput.checked = settings.trayScroll !== false;
    modeSelect.value = TRAY_SCROLL_MODE_OPTIONS.some(option => option.value === settings.trayScrollMode) ? settings.trayScrollMode : DEFAULT_TRAY_SCROLL_MODE;
    showTrayDisplay(settings.trayDisplay);
    if (state.volume === null) showVolume(settings.volume);
  }

  async function saveFlag(key, input) {
    const wanted = input.checked;
    try {
      show(await radio.setSettings({ [key]: wanted }));
      setStatus(statusEl, '✓ Gespeichert');
    } catch (error) {
      input.checked = !wanted;
      setStatus(statusEl, formatIpcError(error), true);
    }
  }

  slider.addEventListener('input', () => {
    output.textContent = `${slider.value} %`;
    slider.setAttribute('aria-valuetext', `${slider.value} Prozent`);
  });
  slider.addEventListener('change', async () => {
    try {
      await radio.setVolume(Number(slider.value) / 100);
      setStatus(statusEl, '✓ Gespeichert');
    } catch (error) {
      setStatus(statusEl, formatIpcError(error), true);
    }
  });

  async function refresh() {
    try {
      state.volume = null;
      show(await radio.getSettings());
      if (radio.getState) {
        const radioState = await radio.getState();
        if (radioState && typeof radioState.volume === 'number') {
          state.volume = radioState.volume;
          showVolume(radioState.volume);
        }
      }
    } catch (error) {
      if (logger) logger.warn('Radio-Einstellungen konnten nicht geladen werden', error && error.message);
      setStatus(statusEl, 'Einstellungen konnten nicht geladen werden', true);
    }
  }

  const unsubscribers = [];
  // Lautstärke folgt dem Mini-Player, solange der Regler nicht gerade bedient wird
  if (radio.onState) {
    unsubscribers.push(
      radio.onState(next => {
        if (next && typeof next.volume === 'number' && (!doc.activeElement || doc.activeElement !== slider)) {
          state.volume = next.volume;
          showVolume(next.volume);
        }
      }),
    );
  }

  return { refresh, getState: () => state, dispose: () => unsubscribers.forEach(off => typeof off === 'function' && off()) };
}

module.exports = { createRadioPlaybackView, OPTIONS, TRAY_DISPLAY_OPTIONS };
