// Radio-Mini-Player (R2): Leiste unten im Hauptfenster, sichtbar auf allen Seiten, solange Radio nicht idle ist.
// Logo, Sender, Titel/Interpret, Vorheriger/Play-Pause/Nächster Favorit, Lautstärke, Stopp. Alle Stream- und
// Nutzerdaten werden per textContent bzw. img.src gesetzt (kein innerHTML mit Daten); Statuswechsel gehen über
// eine aria-live-Region. Die Verdrahtung (Vollbild-Ausblendung, Klick auf den Sendernamen) liegt in renderer.js.

'use strict';

const { miniPlayerModel } = require('./radio-miniplayer-model.js');

const SVG_OPEN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">';
const ICONS = {
  prev: `${SVG_OPEN}<path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>`,
  next: `${SVG_OPEN}<path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>`,
  play: `${SVG_OPEN}<path d="M7 4v16l13-8z"/></svg>`,
  pause: `${SVG_OPEN}<path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>`,
  stop: `${SVG_OPEN}<path d="M6 6h12v12H6z"/></svg>`,
  volume: `${SVG_OPEN}<path d="M3 9v6h4l5 4V5L7 9zM15.5 8.5a5 5 0 0 1 0 7l-1.4-1.4a3 3 0 0 0 0-4.2z"/></svg>`,
};
const ACTION_ICON = { pause: 'pause', stop: 'stop', resume: 'play', play: 'play' };

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(doc, { id, icon, label, className = '' }) {
  const button = el(doc, 'button', `radio-mini-btn ${className}`.trim());
  button.type = 'button';
  button.id = id;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = ICONS[icon]; // statisches SVG, keine Nutzerdaten
  return button;
}

function setIcon(button, icon) {
  if (button.dataset.icon === icon) return;
  button.dataset.icon = icon;
  button.innerHTML = ICONS[icon]; // statisches SVG, keine Nutzerdaten
}

/**
 * options: { radio, getFavoriteCount(), onOpenRadio(), notify(message), logger }
 * Rückgabe: { render, setSuppressed(flag), dispose, getModel }
 */
function createRadioMiniPlayer(root, options = {}) {
  const { radio, getFavoriteCount, onOpenRadio, notify, logger } = options;
  const doc = root.ownerDocument || document;

  root.textContent = '';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Radio-Wiedergabe');

  const logo = el(doc, 'span', 'radio-mini-logo');
  logo.setAttribute('aria-hidden', 'true');
  const logoFallback = el(doc, 'span', 'radio-mini-logo-fallback');
  logo.appendChild(logoFallback);
  let logoImage = null;
  let logoSrc = null;
  let logoFailed = false;

  const info = el(doc, 'button', 'radio-mini-info');
  info.type = 'button';
  info.id = 'radioMiniInfo';
  info.title = 'Radio öffnen';
  const name = el(doc, 'span', 'radio-mini-name');
  const subtitle = el(doc, 'span', 'radio-mini-subtitle');
  info.append(name, subtitle);
  info.addEventListener('click', () => onOpenRadio && onOpenRadio());

  const controls = el(doc, 'div', 'radio-mini-controls');
  const prev = iconButton(doc, { id: 'radioMiniPrev', icon: 'prev', label: 'Vorheriger Favorit' });
  const playPause = iconButton(doc, {
    id: 'radioMiniPlayPause',
    icon: 'pause',
    label: 'Pause',
    className: 'radio-mini-primary',
  });
  const next = iconButton(doc, { id: 'radioMiniNext', icon: 'next', label: 'Nächster Favorit' });
  const stop = iconButton(doc, { id: 'radioMiniStop', icon: 'stop', label: 'Radio stoppen' });
  controls.append(prev, playPause, next, stop);

  const volumeWrap = el(doc, 'label', 'radio-mini-volume');
  const volumeIcon = el(doc, 'span', 'radio-mini-volume-icon');
  volumeIcon.setAttribute('aria-hidden', 'true');
  volumeIcon.innerHTML = ICONS.volume; // statisches SVG
  const volume = doc.createElement('input');
  volume.type = 'range';
  volume.id = 'radioMiniVolume';
  volume.min = '0';
  volume.max = '100';
  volume.step = '1';
  volume.setAttribute('aria-label', 'Radio-Lautstärke');
  volumeWrap.append(volumeIcon, volume);

  // Statuswechsel für Bildschirmleser (höflich), nur bei geändertem Text
  const live = el(doc, 'span', 'sr-only');
  live.id = 'radioMiniLive';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');

  root.append(logo, info, controls, volumeWrap, live);

  let state = null;
  let suppressed = false;
  let volumeDragging = false;
  let lastModel = miniPlayerModel(null);
  let lastLive = '';
  const unsubscribers = [];

  const report = (message, error) => {
    if (logger) logger.warn(`Radio-Mini-Player: ${message}`, error && error.message ? error.message : error || '');
    if (notify) notify(message);
  };
  const run = async (fn, message) => {
    try {
      await fn();
    } catch (error) {
      report(message, error);
    }
  };

  function setLogo(model) {
    logoFallback.textContent = model.initial;
    if (model.logo !== logoSrc) {
      logoSrc = model.logo;
      logoFailed = false;
      if (logoImage) {
        logoImage.remove();
        logoImage = null;
      }
      if (model.logo) {
        const image = doc.createElement('img');
        image.alt = '';
        image.src = model.logo;
        image.addEventListener('error', () => {
          image.remove();
          if (logoImage === image) logoImage = null;
          logoFailed = true;
          logo.classList.add('has-error');
        });
        logoImage = image;
        logo.appendChild(image);
      }
    }
    logo.classList.toggle('has-error', !model.logo || logoFailed);
  }

  function render() {
    const favoriteCount = typeof getFavoriteCount === 'function' ? getFavoriteCount() : 0;
    const model = miniPlayerModel(state, { favoriteCount, suppressed });
    lastModel = model;
    root.hidden = !model.visible;
    root.dataset.state = model.status;
    if (!model.visible) {
      lastLive = '';
      live.textContent = '';
      return model;
    }
    name.textContent = model.name;
    subtitle.textContent = model.subtitle;
    info.setAttribute('aria-label', `${model.name}${model.subtitle ? `, ${model.subtitle}` : ''} – Radio öffnen`);
    setLogo(model);
    setIcon(playPause, ACTION_ICON[model.action]);
    playPause.title = model.playPauseLabel;
    playPause.setAttribute('aria-label', model.playPauseLabel);
    playPause.dataset.action = model.action;
    prev.disabled = !model.canStep;
    next.disabled = !model.canStep;
    if (!volumeDragging) volume.value = String(model.volumePercent);
    volume.setAttribute('aria-valuetext', `${model.volumePercent} Prozent`);
    if (model.live !== lastLive) {
      lastLive = model.live;
      live.textContent = model.live;
    }
    return model;
  }

  playPause.addEventListener('click', () => {
    const action = lastModel.action;
    run(
      () =>
        action === 'pause'
          ? radio.pause()
          : action === 'stop'
            ? radio.stop()
            : action === 'resume'
              ? radio.play()
              : radio.play(stateKey()),
      'Radio: Aktion nicht möglich',
    );
  });
  prev.addEventListener('click', () => run(() => radio.prev(), 'Radio: Vorheriger Favorit nicht möglich'));
  next.addEventListener('click', () => run(() => radio.next(), 'Radio: Nächster Favorit nicht möglich'));
  stop.addEventListener('click', () => run(() => radio.stop(), 'Radio: Stopp nicht möglich'));
  volume.addEventListener('pointerdown', () => {
    volumeDragging = true;
  });
  volume.addEventListener('change', () => {
    volumeDragging = false;
  });
  volume.addEventListener('input', () =>
    run(() => radio.setVolume(Number(volume.value) / 100), 'Radio: Lautstärke nicht änderbar'),
  );
  // Pfeiltasten/Leertaste in der Leiste bedienen nur die Leiste (kein Zapping/Seitenkürzel dahinter)
  root.addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) event.stopPropagation();
  });

  function stateKey() {
    return state && state.station ? { sourceId: state.station.sourceId, stationId: state.station.id } : undefined;
  }

  unsubscribers.push(
    radio.onState(next => {
      state = next;
      render();
    }),
  );
  Promise.resolve(radio.getState())
    .then(initial => {
      if (!state) state = initial;
      render();
    })
    .catch(() => {});

  render();
  return {
    render,
    setSuppressed(flag) {
      const value = Boolean(flag);
      if (value === suppressed) return;
      suppressed = value;
      render();
    },
    dispose() {
      unsubscribers.forEach(unsub => typeof unsub === 'function' && unsub());
    },
    getModel: () => lastModel,
  };
}

module.exports = { createRadioMiniPlayer };
