// YouTube-Mini-Player: Skript und CSS, die in die YouTube-Seiten der beiden Webviews gehen.
//
// Zwei Rollen (Vorbild: iOS-App mytube, Scripts.swift):
//  - 'browse'  die Inhalts-Webview (Stöbern): Klick auf ein Video wird abgefangen und an die App gemeldet,
//              Hover-„+“ auf Vorschaubildern („Zur Playlist hinzufügen“).
//  - 'player'  die Player-Webview (Video): Klick auf eine Nicht-Video-Seite (Logo, Suche, Kanal ...) wird abgefangen und als
//              „Stöbern“ gemeldet, das Video läuft weiter; Taste i und YouTubes Miniplayer-Knopf werden auf den Mini-Player der App umgebogen;
//              Zustand (Position, Pause, Ende ...) geht an die App; Stufen page/mini/app per CSS (nur Video, ohne YouTube-Drumherum).
//
// Das Skript läuft in der Main-World der Seite (Preload: webFrame.executeJavaScript), meldet per window.postMessage
// ({ __shMini: Nachricht }); der Preload reicht das an den Host (sendToHost) weiter, der alles validiert.
// Befehle der App kommen über window.__shMini (executeJavaScript des Webview-Elements).
// Das Stufen-CSS (PLAYER_CSS) steckt im Skripttext und wird als <style> eingefügt (YouTube erlaubt Inline-Styles; webFrame.insertCSS
// aus dem Preload landete im Test im alten Dokument und blieb wirkungslos).

/* global window, document, location, URL, setInterval, clearInterval, setTimeout, clearTimeout, Event -- Main-World-Globals; die Funktion wird als Text in die Seite übertragen */
'use strict';

function youtubeMiniPage(init) {
  if (window.__shMini) return;
  const role = init.role === 'player' ? 'player' : 'browse';
  const cfg = { clickBehavior: init.clickBehavior === 'playlist' ? 'playlist' : 'replace' };
  let listed = new Set(); // Videos, die schon in der Playlist liegen (die App meldet sie per setConfig): das „+“ wird dafür zum Haken
  const ID = /^[A-Za-z0-9_-]{11}$/;
  const post = message => {
    try {
      window.postMessage({ __shMini: message }, '*');
    } catch (e) {
      // Seite ohne postMessage: nichts zu melden
    }
  };
  const parse = href => {
    try {
      return new URL(href, location.href);
    } catch (e) {
      return null;
    }
  };
  const isYt = host => host === 'youtube.com' || host.endsWith('.youtube.com');
  const watchId = href => {
    const u = parse(href);
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return '';
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return ID.test(id) ? id : '';
    }
    if (!isYt(u.hostname)) return '';
    if (u.pathname === '/watch') {
      const v = u.searchParams.get('v') || '';
      return ID.test(v) ? v : '';
    }
    const live = /^\/live\/([^/]+)/.exec(u.pathname);
    return live && ID.test(live[1]) ? live[1] : '';
  };
  const onWatch = () => Boolean(watchId(location.href));
  const stop = e => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  const anchorOf = e => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (const node of path) if (node && node.tagName === 'A' && node.href) return node;
    const t = e.target;
    return t && t.closest ? t.closest('a[href]') : null;
  };
  const CARD_SEL = 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, yt-lockup-view-model, ytd-rich-grid-media, ytd-reel-item-renderer';
  const titleOf = a => {
    const own = (a.getAttribute('title') || '').trim();
    if (own) return own;
    const card = a.closest ? a.closest(CARD_SEL) : null;
    const node = card && card.querySelector('#video-title, h3, .yt-lockup-metadata-view-model-wiz__title, .yt-lockup-metadata-view-model__title');
    const text = node ? (node.getAttribute('title') || node.textContent || '').trim() : '';
    return text.replace(/\s+/g, ' ').slice(0, 200);
  };
  const pageTitle = () => document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '').trim();
  const mainVideo = () => document.querySelector('video.html5-main-video') || document.querySelector('video');
  const isTyping = t => Boolean(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));

  // ── Links ──
  window.addEventListener(
    'click',
    e => {
      if (!e.isTrusted || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const target = e.target;
      if (role === 'player') {
        if (!onWatch()) return;
        // YouTubes Miniplayer-Knopf → Mini-Player der App
        if (target && target.closest && target.closest('.ytp-miniplayer-button')) {
          stop(e);
          post({ type: 'mini' });
          return;
        }
        // Suche per Klick auf die Lupe
        if (target && target.closest && target.closest('button.ytSearchboxComponentSearchButton, #search-icon-legacy')) {
          const input = document.querySelector('input[name="search_query"]');
          const query = input ? input.value.trim() : '';
          if (query) {
            stop(e);
            post({ type: 'browse', url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) });
          }
          return;
        }
      }
      const a = anchorOf(e);
      if (!a || !a.href) return;
      const raw = a.getAttribute('href') || '';
      if (!raw || raw.charAt(0) === '#' || /^javascript:/i.test(raw)) return;
      const id = watchId(a.href);
      if (role === 'browse') {
        if (!id) return;
        stop(e);
        post({ type: 'open', id, title: titleOf(a) });
        return;
      }
      if (!onWatch()) return;
      if (id) {
        if (cfg.clickBehavior === 'playlist' && id !== watchId(location.href)) {
          stop(e);
          post({ type: 'add', id, title: titleOf(a) });
        }
        return; // sonst ersetzt der natürliche Seitenwechsel das laufende Video
      }
      const u = parse(a.href);
      if (!u || !isYt(u.hostname) || u.pathname === '/redirect' || (a.target && a.target !== '_self')) return;
      stop(e);
      post({ type: 'browse', url: u.href });
    },
    true,
  );

  // Suche per Eingabetaste im Player
  if (role === 'player') {
    window.addEventListener(
      'keydown',
      e => {
        if (!e.isTrusted || e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (e.key === 'Enter' && t && t.tagName === 'INPUT' && t.name === 'search_query' && onWatch()) {
          const query = t.value.trim();
          if (query) {
            stop(e);
            post({ type: 'browse', url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) });
          }
          return;
        }
        // Taste i: YouTubes Miniplayer → Mini-Player der App
        if ((e.key === 'i' || e.key === 'I') && !e.shiftKey && !isTyping(t) && onWatch()) {
          stop(e);
          post({ type: 'mini' });
        }
      },
      true,
    );
  }

  // ── Hover-„+“ in der Titelzeile der Kachel, links neben YouTubes Drei-Punkte-Menü ──
  // Außerhalb des Vorschaubilds: dort liegen YouTubes Ton-/Untertitel-Knöpfe der Hover-Vorschau, Hinweise und Laufzeit.
  // Farben: Akzentfarbe der App (--accent in styles.css), die Seite kennt deren CSS-Variablen nicht.
  const ACCENT = '#6c5ce7';
  const ACCENT_HOVER = '#8b7df0';
  const PLUS_SIZE = 28;
  const MENU_SEL = 'ytd-menu-renderer, [class*="MenuButton"], [class*="menu-button"]';
  const THUMB_SEL = 'img, yt-image, yt-thumbnail-view-model';
  const PREVIEW_SEL = 'ytd-video-preview, #video-preview';
  let plus = null;
  let plusFor = null;
  let mode = 'page';
  const isDone = () => Boolean(plusFor && listed.has(plusFor.id));
  const markPlus = () => {
    if (!plus) return;
    const done = isDone();
    const label = done ? 'In der Playlist' : 'Zur Playlist hinzufügen';
    plus.textContent = done ? '\u2713' : '+';
    plus.title = label;
    plus.setAttribute('aria-label', label);
  };
  const setListed = ids => {
    if (!Array.isArray(ids)) return;
    listed = new Set(ids.filter(id => typeof id === 'string' && ID.test(id)));
    markPlus();
  };
  const hidePlus = () => {
    plusFor = null;
    if (plus) {
      plus.style.display = 'none';
      plus.style.background = ACCENT; // versteckt oder verschoben feuert kein mouseleave: Hover-Farbe sonst hängen geblieben
    }
  };
  const ensurePlus = () => {
    if (plus || !document.body) return plus;
    plus = document.createElement('button');
    plus.type = 'button';
    plus.textContent = '+';
    plus.title = 'Zur Playlist hinzufügen';
    plus.setAttribute('aria-label', 'Zur Playlist hinzufügen');
    plus.style.cssText =
      'position:fixed;z-index:2147483600;display:none;width:' + PLUS_SIZE + 'px;height:' + PLUS_SIZE + 'px;padding:0;border:0;border-radius:50%;' +
      'background:' + ACCENT + ';color:#fff;font:700 21px/' + (PLUS_SIZE - 2) + 'px Arial,sans-serif;text-align:center;cursor:pointer;';
    plus.addEventListener('mouseenter', () => (plus.style.background = ACCENT_HOVER));
    plus.addEventListener('mouseleave', () => (plus.style.background = ACCENT));
    plus.addEventListener(
      'click',
      e => {
        stop(e);
        if (plusFor) {
          post({ type: 'add', id: plusFor.id, title: plusFor.title });
          listed.add(plusFor.id); // gilt sofort beim erneuten Überfahren; die App meldet den tatsächlichen Stand per setConfig
        }
        hidePlus();
      },
      true,
    );
    document.body.appendChild(plus);
    return plus;
  };
  // Kachel und Video-Link unter dem Zeiger (innerste Kachel mit Video-Link; Wiedergabeseite: nicht das laufende Video)
  const cardAt = target => {
    const own = role === 'player' ? watchId(location.href) : '';
    for (let card = target && target.closest ? target.closest(CARD_SEL) : null; card; card = card.parentElement ? card.parentElement.closest(CARD_SEL) : null) {
      const links = card.querySelectorAll('a[href]');
      for (const a of links) {
        const id = watchId(a.href);
        if (id && id !== own && a.querySelector(THUMB_SEL)) return { card, a, id };
      }
    }
    return null;
  };
  const placePlus = (button, card) => {
    let left;
    let top;
    const menus = card.querySelectorAll(MENU_SEL);
    let menu = null;
    for (const m of menus) {
      const r = m.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.width <= 64 && r.height <= 64) { // Menü-Knopf ist klein; Container mit „MenuButton“ im Klassennamen nicht
        menu = r;
        break;
      }
    }
    if (menu) {
      left = menu.left - PLUS_SIZE - 2;
      top = menu.top + (menu.height - PLUS_SIZE) / 2;
    } else {
      // Kein Menü gefunden: unter dem Vorschaubild, rechts
      const thumb = card.querySelector(THUMB_SEL);
      const r = (thumb || card).getBoundingClientRect();
      left = r.right - PLUS_SIZE - 4;
      top = r.bottom + 6;
    }
    button.style.left = Math.max(0, Math.min(window.innerWidth - PLUS_SIZE - 2, left)) + 'px';
    button.style.top = Math.max(0, Math.min(window.innerHeight - PLUS_SIZE - 2, top)) + 'px';
  };
  document.addEventListener(
    'mouseover',
    e => {
      if (mode !== 'page' || (role === 'player' && !onWatch())) return;
      const t = e.target;
      if (plus && t === plus) return;
      if (t && t.closest && t.closest(PREVIEW_SEL)) return; // Hover-Vorschau liegt über dem Vorschaubild: „+“ bleibt, wo es ist
      const hit = cardAt(t);
      if (!hit) {
        hidePlus();
        return;
      }
      const button = ensurePlus();
      if (!button) return;
      placePlus(button, hit.card);
      button.style.display = 'block';
      plusFor = { id: hit.id, title: titleOf(hit.a) };
      markPlus();
    },
    true,
  );
  document.addEventListener('scroll', hidePlus, true);
  document.addEventListener(
    'mouseout',
    e => {
      if (!e.relatedTarget) hidePlus(); // Zeiger hat die Seite verlassen
    },
    true,
  );

  if (role !== 'player') {
    window.__shMini = {
      role,
      setConfig(next) {
        if (next && (next.clickBehavior === 'replace' || next.clickBehavior === 'playlist')) cfg.clickBehavior = next.clickBehavior;
        if (next) setListed(next.listed);
      },
    };
    return;
  }

  // ── Player: Zustand an die App melden ──
  let lastPost = 0;
  const report = force => {
    const v = mainVideo();
    if (!v || !onWatch()) return;
    const now = Date.now();
    if (!force && now - lastPost < 500) return;
    lastPost = now;
    const owner = document.querySelector('ytd-watch-metadata #owner #channel-name a, #owner #channel-name a, #channel-name a');
    post({
      type: 'state',
      id: watchId(location.href),
      mode,
      title: pageTitle(),
      channel: owner ? owner.textContent.trim().slice(0, 120) : '',
      time: Number.isFinite(v.currentTime) ? v.currentTime : 0,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      paused: v.paused,
      ended: v.ended,
      loading: !v.paused && v.readyState < 3,
      volume: v.volume,
      muted: v.muted,
    });
  };
  let cancelTimer = 0;
  const cancelAutonav = () => {
    // YouTube blendet am Ende „Nächstes Video“ mit Zähler ein: abbrechen, die App entscheidet über das nächste Video
    clearInterval(cancelTimer);
    let n = 0;
    cancelTimer = setInterval(() => {
      document.querySelectorAll('.ytp-autonav-endscreen-upnext-cancel-button').forEach(b => b.click());
      if (++n > 40) clearInterval(cancelTimer);
    }, 250);
  };
  for (const type of ['play', 'playing', 'pause', 'waiting', 'seeked', 'timeupdate', 'durationchange', 'volumechange', 'loadedmetadata', 'ended']) {
    document.addEventListener(
      type,
      e => {
        if (!e.target || e.target.tagName !== 'VIDEO') return;
        if (type === 'ended') cancelAutonav();
        report(type !== 'timeupdate');
      },
      true,
    );
  }
  window.addEventListener('yt-navigate-finish', () => report(true));

  // ── Player: Stufen (CSS aus init.css, hier die Markierungen) ──
  if (init.css) {
    const addCss = () => {
      if (document.getElementById('sh-mini-css')) return;
      const style = document.createElement('style');
      style.id = 'sh-mini-css';
      style.textContent = init.css;
      (document.head || document.documentElement).appendChild(style);
    };
    if (document.documentElement) addCss();
    else document.addEventListener('DOMContentLoaded', addCss, { once: true });
  }
  const root = { classList: { contains: name => document.documentElement.classList.contains(name), toggle: (name, on) => document.documentElement.classList.toggle(name, on) } };
  const PC_SEL = '#movie_player, .html5-video-player';
  const MARKS = '[data-sh-anc],[data-sh-pc],[data-sh-mid]';
  const inMode = () => root.classList.contains('sh-app') || root.classList.contains('sh-mini');
  const clearMarks = () => {
    document.querySelectorAll(MARKS).forEach(n => {
      n.removeAttribute('data-sh-anc');
      n.removeAttribute('data-sh-pc');
      n.removeAttribute('data-sh-mid');
    });
  };
  const markAncestors = () => {
    if (!inMode()) {
      clearMarks();
      return;
    }
    const v = mainVideo();
    if (!v) return;
    const chain = [];
    for (let n = v.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) chain.push(n);
    let pc = null;
    for (let i = 0; i < chain.length; i++) {
      if (chain[i].matches && chain[i].matches(PC_SEL)) pc = chain[i];
      else if (pc) break;
    }
    if (!pc) pc = chain[1] || chain[0];
    const want = new Set(chain);
    document.querySelectorAll(MARKS).forEach(n => {
      if (!want.has(n)) {
        n.removeAttribute('data-sh-anc');
        n.removeAttribute('data-sh-pc');
        n.removeAttribute('data-sh-mid');
      }
    });
    let inside = true;
    chain.forEach(n => {
      n.setAttribute('data-sh-anc', '1');
      if (n === pc) {
        n.setAttribute('data-sh-pc', '1');
        n.removeAttribute('data-sh-mid');
        inside = false;
      } else if (inside) {
        n.setAttribute('data-sh-mid', '1');
        n.removeAttribute('data-sh-pc');
      } else {
        n.removeAttribute('data-sh-pc');
        n.removeAttribute('data-sh-mid');
      }
    });
  };
  setInterval(() => {
    if (inMode()) markAncestors();
  }, 1000);

  // ── Player: X-Knopf zum Verkleinern (nur App-füllend und Vollbild), oben links, wirkt wie Esc ──
  // Er hängt im Player-Element (#movie_player, bzw. im Vollbild-Element), sonst wäre er im Vollbild unsichtbar.
  const SHRINK_HIDE_MS = 3000;
  let shrink = null;
  let shrinkTimer = 0;
  const shrinkWanted = () => mode === 'app' || Boolean(document.fullscreenElement);
  const hideShrink = () => {
    clearTimeout(shrinkTimer);
    shrinkTimer = 0;
    if (shrink) shrink.style.display = 'none';
  };
  const ensureShrink = () => {
    const host = document.fullscreenElement || document.querySelector('#movie_player') || document.body;
    if (!host) return null;
    if (!shrink) {
      shrink = document.createElement('button');
      shrink.type = 'button';
      shrink.textContent = '\u2715';
      shrink.title = 'Verkleinern (Esc)';
      shrink.setAttribute('aria-label', 'Verkleinern (Esc)');
      shrink.style.cssText =
        'position:absolute;top:12px;left:12px;z-index:2147483647;display:none;align-items:center;justify-content:center;width:34px;height:34px;' +
        'padding:0;border:0;border-radius:50%;background:rgba(0,0,0,.65);color:#fff;font:400 17px/1 Arial,sans-serif;cursor:pointer;';
      for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick']) shrink.addEventListener(type, e => e.stopPropagation());
      shrink.addEventListener('click', e => {
        stop(e);
        if (!e.isTrusted) return;
        hideShrink();
        post({ type: 'shrink' });
      });
    }
    if (shrink.parentNode !== host) host.appendChild(shrink);
    return shrink;
  };
  const showShrink = () => {
    if (!shrinkWanted()) {
      hideShrink();
      return;
    }
    const button = ensureShrink();
    if (!button) return;
    button.style.display = 'flex';
    clearTimeout(shrinkTimer);
    shrinkTimer = setTimeout(hideShrink, SHRINK_HIDE_MS);
  };
  document.addEventListener('mousemove', showShrink, true);
  document.addEventListener('fullscreenchange', hideShrink);

  const api = {
    role,
    setConfig(next) {
      if (next && (next.clickBehavior === 'replace' || next.clickBehavior === 'playlist')) cfg.clickBehavior = next.clickBehavior;
      if (next) setListed(next.listed);
    },
    // 'page' (normale Wiedergabeseite) | 'mini' (nur Video, ohne Steuerung) | 'app' (nur Video mit YouTube-Steuerung)
    setMode(next) {
      mode = next === 'mini' || next === 'app' ? next : 'page';
      hidePlus();
      hideShrink();
      root.classList.toggle('sh-mini', mode === 'mini');
      root.classList.toggle('sh-app', mode === 'app');
      markAncestors();
      if (mode !== 'page') window.scrollTo(0, 0);
      window.dispatchEvent(new Event('resize'));
      return mode;
    },
    play() {
      const v = mainVideo();
      if (v) return v.play();
      return undefined;
    },
    pause() {
      const v = mainVideo();
      if (v) v.pause();
    },
    seek(seconds) {
      const v = mainVideo();
      if (v && Number.isFinite(seconds)) v.currentTime = Math.max(0, seconds);
    },
    volume(value) {
      const v = mainVideo();
      if (v && Number.isFinite(value)) {
        v.volume = Math.min(1, Math.max(0, value));
        v.muted = value === 0;
      }
    },
    fullscreen() {
      const el = document.querySelector('#movie_player') || document.documentElement;
      return el.requestFullscreen ? el.requestFullscreen() : undefined;
    },
    report: () => report(true),
  };
  window.__shMini = api;
  report(true);
}

// Stufen-CSS der Player-Webview: Markierungen setzt das Skript (data-sh-anc/-pc/-mid), siehe mytube (Scripts.swift)
const PLAYER_CSS = `
html.sh-app, html.sh-app body, html.sh-mini, html.sh-mini body { overflow: hidden !important; background: #000 !important; }
:is(html.sh-app, html.sh-mini) [data-sh-anc] { transform: none !important; filter: none !important; contain: none !important;
  perspective: none !important; will-change: auto !important; overflow: visible !important; clip-path: none !important; mask: none !important;
  backdrop-filter: none !important; }
:is(html.sh-app, html.sh-mini) [data-sh-pc] { position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
  width: auto !important; height: auto !important; max-width: none !important; max-height: none !important; min-width: 0 !important;
  min-height: 0 !important; margin: 0 !important; padding: 0 !important; z-index: 2147483000 !important; background: #000 !important;
  overflow: hidden !important; display: block !important; }
:is(html.sh-app, html.sh-mini) [data-sh-mid] { position: absolute !important; top: 0 !important; left: 0 !important; width: 100% !important;
  height: 100% !important; max-width: none !important; max-height: none !important; margin: 0 !important; padding: 0 !important; }
:is(html.sh-app, html.sh-mini) video { position: absolute !important; top: 0 !important; left: 0 !important; width: 100% !important;
  height: 100% !important; max-width: none !important; max-height: none !important; margin: 0 !important; background: #000 !important;
  object-fit: contain !important; }
html.sh-mini [data-sh-anc] > :not([data-sh-anc]):not(video) { display: none !important; }
html.sh-app [data-sh-anc]:not([data-sh-pc]) > :not([data-sh-anc]):not(video) { display: none !important; }
html.sh-app body > :not([data-sh-anc]) { display: none !important; }
/* Platz für den X-Knopf oben links: YouTubes Titelzeile rückt nach rechts */
html.sh-app .ytp-chrome-top, .html5-video-player:fullscreen .ytp-chrome-top { margin-left: 52px !important; }
`;

/** Skripttext für den Preload: Funktion + Aufruf mit den Startwerten { role, clickBehavior } (Player zusätzlich mit dem Stufen-CSS). */
function buildPageScript({ role, clickBehavior }) {
  const isPlayer = role === 'player';
  return `(${youtubeMiniPage.toString()})(${JSON.stringify({ role: isPlayer ? 'player' : 'browse', clickBehavior, css: isPlayer ? PLAYER_CSS : '' })});`;
}

module.exports = { youtubeMiniPage, buildPageScript, PLAYER_CSS };
