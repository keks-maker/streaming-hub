// v0.3.7. – postMessage-Bridge + komplette Shortcut-Weiterleitung inkl. Alt+← (Zurück)
const { ipcRenderer } = require('electron');

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

// Forward clicks: sidebar auto-close when clicking inside webview
document.addEventListener(
  'click',
  () => {
    ipcRenderer.sendToHost('sidebar-close');
  },
  true,
);

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
