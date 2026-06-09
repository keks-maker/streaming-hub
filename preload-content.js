// v0.3.6. – postMessage-Bridge für tv-player Befehle
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
  document.addEventListener('play', function(e) {
    if (e.target.tagName === 'VIDEO') {
      window.postMessage({ type: '__media-play' }, '*');
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
document.addEventListener('keydown', e => {
  if (
    e.key === 'Escape' ||
    e.key === 'F11' ||
    e.key === '?' ||
    e.key === 'ArrowUp' ||
    e.key === 'ArrowDown' ||
    (e.ctrlKey && (e.key === 'Tab' || e.key === 'p' || e.key === 'P'))
  ) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
    }
    ipcRenderer.send('webview-keydown', {
      key: e.key,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
    });
  }
});

// Bridge: page postMessage → host renderer (for tv-player channel commands)
window.addEventListener('message', e => {
  if (e.data && e.data.source === 'tv-player') {
    ipcRenderer.sendToHost('tv-channel', e.data);
  }
});

// Navigation commands from host
ipcRenderer.on('go-back', () => {
  window.history.back();
});
