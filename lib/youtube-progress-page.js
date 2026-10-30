// YouTube-Wiedergabefortschritt: Seitenskript für alle YouTube-Seiten der Partition persist:streaming im Hauptfenster
// (unabhängig vom Mini-Player). Läuft in der Main-World (Preload: webFrame.executeJavaScript), meldet per
// window.postMessage({ __shProgress }) an den Preload; der reicht an den Main weiter, der jede Meldung validiert.
// Nachrichten: { type: 'report', id, t, d } (Position/Dauer in Sekunden) und { type: 'need', id } (gemerkte Position anfordern);
// der Preload antwortet mit window.__shProgressResume(id, position).
// Nur das Hauptvideo der /watch-Seite zählt (ID aus der URL); Shorts, Livestreams und Links mit fester Startzeit (t=, start=) werden nicht fortgesetzt.

/* global window, CustomEvent, document, location, URL, setInterval -- Main-World-Globals; die Funktionen werden als Text in die Seite übertragen */
'use strict';

/** Video-ID der Wiedergabeseite (nur /watch auf YouTube-Hosts), sonst '' (Shorts, Start, Suche, Kanal ...). */
function progressVideoId(href) {
  try {
    const u = new URL(href);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return '';
    if (u.pathname !== '/watch') return '';
    const id = u.searchParams.get('v') || '';
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
  } catch (e) {
    return '';
  }
}

/** Trägt die Adresse eine feste Startzeit (t= oder start=)? Dann gewinnt der Link, nicht der gemerkte Stand. */
function progressHasStartTime(href) {
  try {
    const u = new URL(href);
    return Boolean(u.searchParams.get('t') || u.searchParams.get('start'));
  } catch (e) {
    return false;
  }
}

function youtubeProgressPage(videoIdOf, hasStartTime) {
  if (window.__shProgress) return;
  window.__shProgress = true;
  // sync: beim Entladen (pagehide) wird postMessage nicht mehr zugestellt; ein CustomEvent läuft synchron zum Preload (gemeinsames DOM, Detail als String)
  const post = (message, sync) => {
    try {
      if (sync && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('__shProgressSync', { detail: JSON.stringify({ __shProgress: message }) }));
      else window.postMessage({ __shProgress: message }, '*');
    } catch (e) {
      // Seite ohne postMessage: nichts zu melden
    }
  };
  // cur: das aktuell gezählte Video-Aufruf { id, armed, skipResume, resume, resumed, last }
  //  armed = der Player trägt wirklich dieses Video (nach loadedmetadata); last = letzter Stand { t, d} zum Sichern beim Wechsel
  let cur = null;
  // Selektoren der Reihe nach (nicht DOM-Reihenfolge); Hover-Vorschau-Player (auch html5-main-video) werden verworfen; nur auf /watch
  const PREVIEW = 'ytd-video-preview, #inline-player, #video-preview';
  const SELECTORS = ['#movie_player video.html5-main-video', '#movie_player video', 'ytm-custom-control video', 'video.html5-main-video', 'video'];
  const mainVideo = () => {
    if (!videoIdOf(location.href)) return null;
    for (const sel of SELECTORS) {
      const found = Array.from(document.querySelectorAll(sel)).find(v => !(v.closest && v.closest(PREVIEW)));
      if (found) return found;
    }
    return null;
  };
  const adShowing = () => Boolean(document.querySelector('.ad-showing, .ad-interrupting'));
  // Livestreams (Dauer nicht endlich) und Werbung zählen nie
  const playable = v => Boolean(v) && Number.isFinite(v.duration) && v.duration > 0 && Number.isFinite(v.currentTime) && v.currentTime >= 0 && !adShowing();
  // Meldungen erst, wenn für die ID die Dauer des Hauptvideos (loadedmetadata ohne Werbung) feststeht und v.duration dazu passt (±1 s):
  // eine Werbung (andere Dauer, t ≈ Ende) darf nie unter der Video-ID melden
  const valid = v => playable(v) && Boolean(cur) && cur.dur > 0 && Math.abs(v.duration - cur.dur) <= 1;
  const remember = v => {
    if (cur && cur.armed && valid(v)) cur.last = { t: v.currentTime, d: v.duration };
  };
  const send = sync => {
    if (cur && cur.last) post({ type: 'report', id: cur.id, t: cur.last.t, d: cur.last.d }, sync === true);
  };
  // liest den Player (er trägt noch das alte Video) und sichert den Stand: Seitenwechsel, Pause
  const flush = sync => {
    if (!cur) return;
    remember(mainVideo());
    send(sync === true);
  };
  const tryResume = () => {
    const v = mainVideo();
    if (!cur || !cur.armed || cur.resumed || cur.resume <= 0 || !v || v.readyState < 1 || !valid(v)) return;
    cur.resumed = true;
    try {
      v.currentTime = Math.min(cur.resume, Math.max(v.duration - 11, 0));
    } catch (e) {
      // Player lässt das Setzen nicht zu: dann von vorn
    }
  };
  let first = true;
  const sync = () => {
    const id = videoIdOf(location.href);
    if (cur && cur.id === id) return;
    send(); // letzter bekannter Stand des alten Videos (der Player trägt inzwischen eventuell schon das neue)
    cur = null;
    if (!id) return;
    const v = mainVideo();
    const ready = first && playable(v) && v.readyState >= 1;
    cur = { id, armed: ready, dur: ready ? v.duration : 0, skipResume: hasStartTime(location.href), resume: 0, resumed: false, last: null };
    first = false;
    post({ type: 'need', id });
  };
  window.__shProgressResume = (id, position) => {
    if (!cur || cur.id !== id || cur.skipResume || !Number.isFinite(position) || position < 3) return;
    cur.resume = position;
    tryResume();
  };
  const onVideo = (e, type) => {
    const v = e.target;
    if (!v || v.tagName !== 'VIDEO') return;
    sync();
    if (!cur || v !== mainVideo()) return;
    if (type === 'loadedmetadata' && playable(v)) {
      cur.armed = true;
      cur.dur = v.duration;
    }
    if (!cur.armed) return;
    tryResume();
    remember(v);
    if (type === 'pause' || type === 'seeked') send();
    if (type === 'ended' && valid(v)) {
      post({ type: 'report', id: cur.id, t: v.duration, d: v.duration });
      cur.last = null;
    }
  };
  ['loadedmetadata', 'canplay', 'timeupdate', 'pause', 'seeked', 'ended'].forEach(type => {
    document.addEventListener(type, e => onVideo(e, type), true);
  });
  // Videowechsel innerhalb der Seite (YouTube-SPA, kein pagehide): letzten Stand des alten Videos sichern, bevor die neue Adresse greift
  document.addEventListener('yt-navigate-start', flush, true);
  ['yt-navigate-finish', 'yt-page-data-updated'].forEach(type => document.addEventListener(type, sync, true));
  window.addEventListener('pagehide', () => flush(true));
  setInterval(sync, 800);
  setInterval(() => {
    const v = mainVideo();
    if (cur && cur.armed && v && !v.paused && !v.ended) {
      remember(v);
      send();
    }
  }, 5000);
  sync();
}

/** Skripttext für den Preload. */
function buildProgressScript() {
  return `(${youtubeProgressPage.toString()})(${progressVideoId.toString()}, ${progressHasStartTime.toString()});`;
}

module.exports = { progressVideoId, progressHasStartTime, youtubeProgressPage, buildProgressScript };
