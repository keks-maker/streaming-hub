// v0.3.7. – postMessage-Bridge + komplette Shortcut-Weiterleitung inkl. Alt+← (Zurück)
const { ipcRenderer, contextBridge, webFrame } = require('electron');

// ── YouTube-Werbeblocker ──
// Läuft synchron beim Preload-Start, also vor allen Seitenskripten, direkt in der Main-World
// (contextBridge.executeInMainWorld: unabhängig von CSP und Trusted Types, anders als ein <script>-Element).
// Ob der Blocker aktiv ist (Schalter an UND YouTube-Seite), entscheidet der Main (lib/youtube-adblock-ipc.js).
// Logik aus der iOS-App mytube (Scripts.swift): Werbung aus Player-Antworten entfernen + Skip-Fallback.
/* global Response, setInterval -- Main-World-Globals; die Funktion wird als Text in die Seite übertragen */
function youtubeAdblockMainWorld() {
  if (window.__shAdblock) return;
  window.__shAdblock = true;
  const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots'];
  // Werbe-Kacheln in Feed-Antworten (Browse/Next): ganze Einträge samt Wrapper aus den Listen entfernen,
  // damit das Raster nachrückt. Nur Arrays werden gefiltert; Tiefe begrenzt, Guide u. a. bleiben unberührt.
  const AD_RENDERERS = [
    'adSlotRenderer', 'displayAdRenderer', 'promotedSparklesWebRenderer', 'promotedSparklesTextSearchRenderer',
    'promotedVideoRenderer', 'inFeedAdLayoutRenderer', 'brandVideoSingletonRenderer', 'searchPyvRenderer',
  ];
  const WRAPPERS = ['richItemRenderer', 'richSectionRenderer', 'itemSectionRenderer'];
  const isAdEntry = e => {
    if (!e || typeof e !== 'object') return false;
    for (const r of AD_RENDERERS) if (r in e) return true;
    for (const w of WRAPPERS) {
      const inner = e[w];
      if (inner && typeof inner === 'object') {
        const c = inner.content;
        if (c && typeof c === 'object') for (const r of AD_RENDERERS) if (r in c) return true;
        // itemSectionRenderer: nur wenn die Liste ausschließlich aus Werbung besteht
        const list = inner.contents;
        if (w === 'itemSectionRenderer' && Array.isArray(list) && list.length && list.every(isAdEntry)) return true;
      }
    }
    return false;
  };
  const dropAdTiles = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 14) return;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        if (isAdEntry(node[i])) node.splice(i, 1);
        else dropAdTiles(node[i], depth + 1);
      }
      return;
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') dropAdTiles(v, depth + 1);
    }
  };
  const isFeedData = o => 'responseContext' in o || 'onResponseReceivedActions' in o || ('contents' in o && 'header' in o);
  const strip = o => {
    try {
      if (o && typeof o === 'object') {
        for (const k of AD_KEYS) if (k in o) delete o[k];
        if (o.playerResponse) strip(o.playerResponse);
        if (!Array.isArray(o) && isFeedData(o)) dropAdTiles(o, 0);
      }
    } catch (e) {
      // fremdes Objekt: unverändert durchreichen
    }
    return o;
  };
  const parse = JSON.parse;
  JSON.parse = function () {
    return strip(parse.apply(this, arguments));
  };
  const json = Response.prototype.json;
  Response.prototype.json = function () {
    return json.apply(this, arguments).then(strip);
  };
  try {
    let initialPlayerResponse;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get() {
        return initialPlayerResponse;
      },
      set(v) {
        initialPlayerResponse = strip(v);
      },
    });
  } catch (e) {
    // Eigenschaft schon fest definiert: Antworten werden trotzdem über JSON.parse/json() bereinigt
  }
  try {
    let initialData;
    Object.defineProperty(window, 'ytInitialData', {
      configurable: true,
      get() {
        return initialData;
      },
      set(v) {
        initialData = strip(v);
      },
    });
  } catch (e) {
    // Eigenschaft schon fest definiert: Folgeantworten werden trotzdem bereinigt
  }
  // Fallback: läuft doch eine Anzeige, ans Ende springen bzw. überspringen
  setInterval(() => {
    const v = document.querySelector('video');
    if (document.querySelector('.ad-showing, .ad-interrupting') && v && isFinite(v.duration) && v.duration > 0) {
      v.currentTime = v.duration;
    }
    document
      .querySelectorAll('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button')
      .forEach(b => b.click());
  }, 400);
}

try {
  const adblockState = ipcRenderer.sendSync('youtube-adblock:page-state');
  if (adblockState && adblockState.active === true) {
    contextBridge.executeInMainWorld({ func: youtubeAdblockMainWorld });
    if (typeof adblockState.css === 'string' && adblockState.css) webFrame.insertCSS(adblockState.css);
  }
} catch (_) {
  // Blocker ist optional: nie den restlichen Preload verhindern
}

// ── YouTube-Mini-Player ──
// Skript (samt Stufen-CSS) liefert der Main (lib/youtube-mini-ipc.js, page-state): nur bei eingeschaltetem Mini-Player und YouTube-Seite.
// Das Skript meldet per window.postMessage ({ __shMini }); hier wird es an den Host (Renderer) weitergereicht, der alles prüft.
try {
  const miniState = ipcRenderer.sendSync('youtube-mini:page-state');
  if (miniState && miniState.active === true && typeof miniState.script === 'string' && miniState.script) {
    webFrame.executeJavaScript(miniState.script).catch(() => {});
    window.addEventListener('message', e => {
      if (e.source !== window || !e.data || typeof e.data !== 'object' || !e.data.__shMini || typeof e.data.__shMini !== 'object') return;
      ipcRenderer.sendToHost('youtube-mini', e.data.__shMini);
    });
  }
} catch (_) {
  // Mini-Player ist optional: nie den restlichen Preload verhindern
}

// ── YouTube-Wiedergabefortschritt ──
// Skript liefert der Main (lib/youtube-progress-ipc.js, page-state), unabhängig vom Mini-Player. Es meldet per window.postMessage
// ({ __shProgress }); hier wird an den Main weitergereicht (dort validiert) und die gemerkte Position zurückgegeben.
try {
  const progressState = ipcRenderer.sendSync('youtube-progress:page-state');
  if (progressState && progressState.active === true && typeof progressState.script === 'string' && progressState.script) {
    webFrame.executeJavaScript(progressState.script).catch(() => {});
    window.addEventListener('message', e => {
      if (e.source !== window || !e.data || typeof e.data !== 'object' || !e.data.__shProgress || typeof e.data.__shProgress !== 'object') return;
      const m = e.data.__shProgress;
      if (m.type === 'report') {
        ipcRenderer.send('youtube-progress:report', { id: m.id, t: m.t, d: m.d });
      } else if (m.type === 'need' && typeof m.id === 'string') {
        ipcRenderer
          .invoke('youtube-progress:get-position', m.id)
          .then(position => {
            if (typeof position === 'number' && position > 0) {
              return webFrame.executeJavaScript(`window.__shProgressResume&&window.__shProgressResume(${JSON.stringify(m.id)},${position})`);
            }
          })
          .catch(() => {});
      }
    });
  }
} catch (_) {
  // Fortschritt ist optional: nie den restlichen Preload verhindern
}

const script = document.createElement('script');
script.textContent = `
(function() {
  // Disable automation detection
  Object.defineProperty(navigator, 'webdriver', { value: undefined });

  // Chrome-specific globals
  if (!window.chrome) {
    window.chrome = {
      runtime: { id: '' },
      loadTimes: () => ({
        requestTime: 0, startLoadTime: 0, commitLoadTime: 0,
        finishDocumentLoadTime: 0, finishLoadTime: 0, firstPaintTime: 0,
        firstPaintAfterLoadTime: 0, navigationType: 'other',
        wasFetchedViaSpdy: true, wasNpnNegotiated: true,
        npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false,
        connectionInfo: 'http/2',
      }),
      csi: () => ({ startE: 0, onloadT: 0, pageT: Date.now(), tran: 15 }),
      app: { isInstalled: false },
    };
  }

  // Realistic navigator properties
  Object.defineProperties(navigator, {
    deviceMemory: { value: 8 },
    hardwareConcurrency: { value: 8 },
    maxTouchPoints: { value: 0 },
    pdfViewerEnabled: { value: true },
  });
  navigator.languages = ['de-DE', 'de', 'en-US', 'en'];

  // Chrome-like plugins
  const pluginData = [
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', suffixes: 'pdf' },
    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', suffixes: 'pdf' },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', suffixes: '' },
  ];
  const plugins = [];
  pluginData.forEach(function(p) { plugins.push(p); });
  Object.defineProperty(navigator, 'plugins', {
    get: function() {
      const p = [].concat(plugins);
      p.item = function(i) { return p[i] || null; };
      p.namedItem = function(n) { for (let j = 0; j < p.length; j++) { if (p[j].name === n) return p[j]; } return null; };
      p.refresh = function() {};
      return p;
    }
  });

  // userAgentData (User-Agent Client Hints)
  Object.defineProperty(navigator, 'userAgentData', {
    get: function() {
      return {
        brands: [
          { brand: 'Chromium', version: '134' },
          { brand: 'Google Chrome', version: '134' },
          { brand: 'Not;A=Brand', version: '99' },
        ],
        mobile: false,
        platform: '${(function () {
          switch (process.platform) {
            case 'darwin':
              return 'macOS';
            case 'win32':
              return 'Windows';
            default:
              return 'Linux';
          }
        })()}',
        getHighEntropyValues: function() { return Promise.resolve({}); },
        toJSON: function() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
      };
    }
  });

  // window.external (some Google checks reference it)
  if (!window.external) {
    window.external = { AddSearchProvider: function(){}, IsSearchProviderInstalled: function(){} };
  }

  // Notify preload when a video starts playing (for Media Session polling trigger)
  // targetOrigin '*' statt window.location.origin: file://-Guests haben origin
  // "null" — der Origin-String wirft dort "Invalid target origin 'null'"
  // (gleiche Wurzel wie F-FB-07). Eigenes Window → kein Cross-Origin-Leak.
  document.addEventListener('play', function(e) {
    if (e.target.tagName === 'VIDEO') {
      try { window.postMessage({ type: '__media-play' }, '*'); } catch (_) {}
    }
  }, true);
})();
`;
if (document.documentElement) {
  document.documentElement.appendChild(script);
} else {
  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.appendChild(script);
  });
}

// Forward keyboard shortcuts to main window (via main process)
// Alt+← ("Zurück") wird ebenfalls weitergeleitet – so funktioniert die
// Zurück-Navigation auch, wenn der Fokus in einem Webview liegt.
// Pfeiltasten hoch/runter nur im TV-Player (tv.html) weiterleiten und
// unterdrücken, damit Pfeiltasten-Scrolling auf Streaming-Seiten
// (YouTube & Co.) weiterhin funktioniert.
const isTvPlayerPage = () => location.pathname.endsWith('tv.html');

document.addEventListener('keydown', e => {
  if (!e.isTrusted) return;
  if (
    e.key === 'Escape' ||
    e.key === 'F11' ||
    e.key === '?' ||
    (isTvPlayerPage() && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) ||
    (e.altKey && e.key === 'ArrowLeft') ||
    (e.ctrlKey &&
      (e.key === 'Tab' ||
        e.key === 'p' ||
        e.key === 'P' ||
        e.key === 'h' ||
        e.key === 'H' ||
        e.key === 't' ||
        e.key === 'T'))
  ) {
    if ((isTvPlayerPage() && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) || (e.altKey && e.key === 'ArrowLeft')) {
      e.preventDefault();
    }
    ipcRenderer.send('webview-keydown', {
      key: e.key,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
    });
  }
});

// Native host → TV-player command bridge. This avoids relying on window.postMessage
// between the host renderer and the embedded file:// page.
ipcRenderer.on('tv-player-command', (_event, data) => {
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
  window.dispatchEvent(new CustomEvent('streaming-hub-tv-command', { detail: data }));
});

// Bridge: page postMessage → host renderer (for tv-player channel commands)
// Phase 1c: zusätzlich Aufnahme-Requests (recording-start/stop/status).
// Start/Stop-Payloads sind kleine Objekte (untilEpgEnd-Flag, recId) und werden
// im Host validiert (renderer → recording:*-IPC → Engine-Validierung).
// F-FB-07 (t_9372a4b3): Der alte Gate `e.origin === window.location.origin`
// matcht auf file://-Guests NIE — dort ist origin der String "null" (und die
// Iso-Welt sieht location.origin ebenfalls als "null"/leer). Das Gate ist
// deshalb: gleiches Fenster (e.source) + action-Whitelist. Das schützt gegen
// fremde Seiten im tvView (gibt es nicht — loadURL nur auf tv.html) und
// gegen manipulationierte Payloads (Host validiert recording-Requests).
window.addEventListener('message', e => {
  if (e.source === window && e.data && e.data.source === 'tv-player') {
    if (
      e.data.action === 'channel-next' ||
      e.data.action === 'channel-prev' ||
      e.data.action === 'request-epg' ||
      // A-Fail R2-FB-01 (t_d6ee955e): tv.html fragt nach dem Kanal-Kontext
      // direkt nach dem Initial-Load (Reload/Restore-Race-Fallback).
      e.data.action === 'channel-context' ||
      e.data.action === 'recording-start' ||
      e.data.action === 'recording-stop' ||
      e.data.action === 'recording-status'
    ) {
      ipcRenderer.sendToHost('tv-channel', { source: 'tv-player', action: e.data.action, payload: e.data });
    }
  }
});
