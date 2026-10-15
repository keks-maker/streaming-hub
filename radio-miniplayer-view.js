// Radio-Mini-Player (R2): Leiste unten im Hauptfenster, sichtbar auf allen Seiten, solange Radio nicht idle ist.
// Logo, Sender, Titel/Interpret, Vorheriger/Play-Pause/Nächster Favorit, Lautstärke, Stopp.
// Podcast (P2): läuft eine Episode (Option podcasts = window.podcasts.player), zeigt dieselbe Leiste Cover, Sendung – Episode,
// Fortschrittsbalken mit Seek (Pfeiltasten ±5 s), −15/+30 s, Geschwindigkeit, Lautstärke und Stopp; Radio bleibt unverändert. Alle Stream- und
// Nutzerdaten werden per textContent bzw. img.src gesetzt (kein innerHTML mit Daten); Statuswechsel gehen über
// eine aria-live-Region. Die Verdrahtung (Vollbild-Ausblendung, Klick auf den Sendernamen) liegt in renderer.js.

'use strict';

const { miniPlayerModel, podcastMiniPlayerModel, rateLabel, PODCAST_RATES, SEEK_KEY_SECONDS } = require('./radio-miniplayer-model.js');

const SVG_OPEN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">';
const ICONS = {
  prev: `${SVG_OPEN}<path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>`,
  next: `${SVG_OPEN}<path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>`,
  play: `${SVG_OPEN}<path d="M7 4v16l13-8z"/></svg>`,
  pause: `${SVG_OPEN}<path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>`,
  stop: `${SVG_OPEN}<path d="M6 6h12v12H6z"/></svg>`,
  back: `${SVG_OPEN}<path d="M12 5V2L7 6.5 12 11V8a5 5 0 1 1-5 5H5a7 7 0 1 0 7-8z"/></svg>`,
  forward: `${SVG_OPEN}<path d="M12 5V2l5 4.5L12 11V8a5 5 0 1 0 5 5h2a7 7 0 1 1-7-8z"/></svg>`,
  volume: `${SVG_OPEN}<path d="M3 9v6h4l5 4V5L7 9zM15.5 8.5a5 5 0 0 1 0 7l-1.4-1.4a3 3 0 0 0 0-4.2z"/></svg>`,
};
const ACTION_ICON = { pause: 'pause', stop: 'stop', resume: 'play', play: 'play', replay: 'play', retry: 'play' };

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
 * options: { radio, podcasts (optional: window.podcasts.player), getFavoriteCount(), onOpenRadio(), onOpenPodcast(state) (optional), resolveCover(url) → Promise<ladbare URL|null> (optional; http-Cover über den Main), notify(message), logger }
 * Rückgabe: { render, setSuppressed(flag), dispose, getModel }
 */
function createRadioMiniPlayer(root, options = {}) {
  const { radio, podcasts = null, getFavoriteCount, onOpenRadio, onOpenPodcast, resolveCover = null, notify, logger } = options;
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
  info.addEventListener('click', () => {
    if (root.dataset.mode === 'podcast') {
      if (onOpenPodcast) onOpenPodcast(podcastState);
    } else if (onOpenRadio) onOpenRadio();
  });

  // Podcast: Fortschritt (Position, Balken mit Seek, Dauer); bei Radio verborgen
  const progress = el(doc, 'div', 'radio-mini-progress');
  progress.hidden = true;
  const positionText = el(doc, 'span', 'radio-mini-time');
  positionText.id = 'radioMiniPosition';
  const seek = doc.createElement('input');
  seek.type = 'range';
  seek.id = 'radioMiniSeek';
  seek.className = 'radio-mini-seek';
  seek.min = '0';
  seek.max = '0';
  seek.step = '1';
  seek.value = '0';
  seek.setAttribute('aria-label', 'Position in der Episode');
  const durationText = el(doc, 'span', 'radio-mini-time');
  durationText.id = 'radioMiniDuration';
  progress.append(positionText, seek, durationText);

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
  const skipBack = iconButton(doc, { id: 'radioMiniSkipBack', icon: 'back', label: '15 Sekunden zurück', className: 'radio-mini-skip' });
  const skipForward = iconButton(doc, { id: 'radioMiniSkipForward', icon: 'forward', label: '30 Sekunden vor', className: 'radio-mini-skip' });
  skipBack.hidden = true;
  skipForward.hidden = true;
  controls.append(prev, skipBack, playPause, skipForward, next, stop);

  const rateWrap = el(doc, 'label', 'radio-mini-rate');
  rateWrap.hidden = true;
  const rate = doc.createElement('select');
  rate.id = 'radioMiniRate';
  rate.setAttribute('aria-label', 'Wiedergabegeschwindigkeit');
  for (const value of PODCAST_RATES) {
    const option = el(doc, 'option', '', rateLabel(value));
    option.value = String(value);
    rate.appendChild(option);
  }
  rateWrap.appendChild(rate);

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

  root.append(logo, info, progress, controls, rateWrap, volumeWrap, live);

  let state = null;
  let podcastState = null;
  let suppressed = false;
  let volumeDragging = false;
  let seekDragging = false;
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
        const fail = () => {
          image.remove();
          if (logoImage === image) logoImage = null;
          logoFailed = true;
          logo.classList.add('has-error');
        };
        image.addEventListener('error', fail);
        logoImage = image;
        logo.appendChild(image);
        if (/^http:/i.test(model.logo)) {
          // http-Cover erlaubt die CSP nicht: der Main lädt das Bild (data:-URL); ohne Lader bleiben die Initialen
          if (resolveCover) {
            resolveCover(model.logo)
              .then(source => {
                if (logoImage !== image) return;
                if (source) image.src = source;
                else fail();
              })
              .catch(() => logoImage === image && fail());
          } else fail();
        } else image.src = model.logo;
      }
    }
    logo.classList.toggle('has-error', !model.logo || logoFailed);
  }

  function renderPodcast(model) {
    root.hidden = false;
    root.dataset.state = model.status;
    root.dataset.mode = 'podcast';
    root.setAttribute('aria-label', 'Podcast-Wiedergabe');
    name.textContent = model.name;
    subtitle.textContent = model.subtitle;
    info.disabled = typeof onOpenPodcast !== 'function';
    info.title = info.disabled ? '' : 'Podcast öffnen';
    info.setAttribute('aria-label', `${model.name}${model.subtitle ? `, ${model.subtitle}` : ''}${info.disabled ? '' : ' – Podcast öffnen'}`);
    setLogo({ logo: model.cover, initial: model.initial });
    setIcon(playPause, ACTION_ICON[model.action]);
    playPause.title = model.playPauseLabel;
    playPause.setAttribute('aria-label', model.playPauseLabel);
    playPause.dataset.action = model.action;
    progress.hidden = false;
    skipBack.hidden = false;
    skipForward.hidden = false;
    rateWrap.hidden = false;
    prev.hidden = true;
    next.hidden = true;
    stop.title = 'Podcast stoppen';
    stop.setAttribute('aria-label', 'Podcast stoppen');
    volume.setAttribute('aria-label', 'Podcast-Lautstärke');
    skipBack.disabled = !model.canSeek;
    skipForward.disabled = !model.canSeek;
    seek.disabled = !model.canSeek;
    seek.max = String(model.seekMax);
    if (!seekDragging) {
      seek.value = String(model.seekValue);
      positionText.textContent = model.positionText;
    }
    durationText.textContent = model.durationText;
    seek.setAttribute('aria-valuemin', '0');
    seek.setAttribute('aria-valuemax', String(model.seekMax));
    seek.setAttribute('aria-valuenow', String(model.seekValue));
    seek.setAttribute('aria-valuetext', model.valueText);
    rate.value = String(model.rate);
    if (!volumeDragging) volume.value = String(model.volumePercent);
    volume.setAttribute('aria-valuetext', `${model.volumePercent} Prozent`);
    if (model.live !== lastLive) {
      lastLive = model.live;
      live.textContent = model.live;
    }
  }

  function renderRadioChrome() {
    root.dataset.mode = 'radio';
    root.setAttribute('aria-label', 'Radio-Wiedergabe');
    info.disabled = false;
    info.title = 'Radio öffnen';
    progress.hidden = true;
    skipBack.hidden = true;
    skipForward.hidden = true;
    rateWrap.hidden = true;
    prev.hidden = false;
    next.hidden = false;
    stop.title = 'Radio stoppen';
    stop.setAttribute('aria-label', 'Radio stoppen');
    volume.setAttribute('aria-label', 'Radio-Lautstärke');
  }

  function render() {
    const podcastModel = podcastMiniPlayerModel(podcastState, { suppressed });
    if (podcastModel.visible) {
      lastModel = podcastModel;
      renderPodcast(podcastModel);
      return podcastModel;
    }
    renderRadioChrome();
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
    if (lastModel.mode === 'podcast') {
      const episode = podcastState && podcastState.episode;
      run(
        () =>
          action === 'pause'
            ? podcasts.pause()
            : action === 'resume'
              ? podcasts.resume()
              : episode
                ? podcasts.play({ podcastId: episode.podcastId, episodeId: episode.episodeId })
                : undefined,
        'Podcast: Aktion nicht möglich',
      );
      return;
    }
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
  stop.addEventListener('click', () => {
    if (lastModel.mode === 'podcast') run(() => podcasts.stop(), 'Podcast: Stopp nicht möglich');
    else run(() => radio.stop(), 'Radio: Stopp nicht möglich');
  });
  skipBack.addEventListener('click', () => run(() => podcasts.skip(-lastModel.skipBack), 'Podcast: Sprung nicht möglich'));
  skipForward.addEventListener('click', () => run(() => podcasts.skip(lastModel.skipForward), 'Podcast: Sprung nicht möglich'));
  rate.addEventListener('change', () => run(() => podcasts.setRate(Number(rate.value)), 'Podcast: Geschwindigkeit nicht änderbar'));
  // Seek: beim Ziehen nur die Anzeige nachführen, beim Loslassen springen; Pfeiltasten springen ±5 s, Pos1/Ende an die Grenzen
  seek.addEventListener('pointerdown', () => {
    seekDragging = true;
  });
  seek.addEventListener('input', () => {
    positionText.textContent = lastModel.mode === 'podcast' ? formatSeekText(Number(seek.value)) : positionText.textContent;
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    seek.addEventListener(type, () => {
      seekDragging = false;
    });
  }
  // Loslassen außerhalb des Reglers: pointerup landet am Dokument
  doc.addEventListener('pointerup', () => {
    seekDragging = false;
  });
  seek.addEventListener('change', () => {
    seekDragging = false;
    run(() => podcasts.seek(Number(seek.value)), 'Podcast: Springen nicht möglich');
  });
  seek.addEventListener('keydown', event => {
    const step = { ArrowLeft: -SEEK_KEY_SECONDS, ArrowDown: -SEEK_KEY_SECONDS, ArrowRight: SEEK_KEY_SECONDS, ArrowUp: SEEK_KEY_SECONDS }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      run(() => podcasts.skip(step), 'Podcast: Springen nicht möglich');
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      run(() => podcasts.seek(event.key === 'Home' ? 0 : lastModel.duration), 'Podcast: Springen nicht möglich');
    }
  });
  volume.addEventListener('pointerdown', () => {
    volumeDragging = true;
  });
  volume.addEventListener('change', () => {
    volumeDragging = false;
  });
  volume.addEventListener('input', () => {
    if (lastModel.mode === 'podcast') run(() => podcasts.setVolume(Number(volume.value) / 100), 'Podcast: Lautstärke nicht änderbar');
    else run(() => radio.setVolume(Number(volume.value) / 100), 'Radio: Lautstärke nicht änderbar');
  });
  // Pfeiltasten/Leertaste in der Leiste bedienen nur die Leiste (kein Zapping/Seitenkürzel dahinter)
  root.addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) event.stopPropagation();
  });

  function stateKey() {
    return state && state.station ? { sourceId: state.station.sourceId, stationId: state.station.id } : undefined;
  }

  function formatSeekText(seconds) {
    return podcastMiniPlayerModel({ ...podcastState, position: seconds }, {}).positionText;
  }

  unsubscribers.push(
    radio.onState(next => {
      state = next;
      render();
    }),
  );
  if (podcasts) {
    // Positionsmeldungen kommen höchstens einmal pro Sekunde; render() ist billig und setzt nur geänderte Werte
    unsubscribers.push(
      podcasts.onState(next => {
        podcastState = next;
        render();
      }),
    );
    Promise.resolve(podcasts.getState())
      .then(initial => {
        if (!podcastState) podcastState = initial;
        render();
      })
      .catch(() => {});
  }
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
