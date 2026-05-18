document.addEventListener('DOMContentLoaded', () => {
  const navItems = document.querySelectorAll('.nav-item');
  const overlayBar = document.getElementById('overlayBar');
  const toolbar = document.getElementById('toolbar');
  const contentArea = document.getElementById('contentArea');
  const welcomeScreen = document.getElementById('welcomeScreen');
  const urlDisplay = document.getElementById('urlDisplay');
  const serviceName = document.getElementById('serviceName');
  const overlayLocation = document.getElementById('overlayLocation');
  const backBtn = document.getElementById('backBtn');
  const forwardBtn = document.getElementById('forwardBtn');
  const reloadBtn = document.getElementById('reloadBtn');
  const pipBtn = document.getElementById('pipBtn');
  const webview = document.getElementById('contentView');

  const providerNames = {
    netflix: 'Netflix',
    youtube: 'YouTube',
    disney: 'Disney+',
    prime: 'Prime Video',
    twitch: 'Twitch',
    spotify: 'Spotify'
  };

  const chromeUA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

  let webviewReady = false;
  let pendingNav = null;

  webview.addEventListener('did-attach', () => {
    webviewReady = true;
    if (pendingNav) {
      webview.loadURL(pendingNav);
      pendingNav = null;
    }
  });

  const chromeEnv = `
    Object.defineProperty(navigator, 'webdriver', { value: undefined });
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
  `;

  webview.addEventListener('dom-ready', () => {
    webview.setUserAgent(chromeUA);
    webview.executeJavaScript(chromeEnv).catch(() => {});
  });

  webview.addEventListener('did-finish-load', () => {
    webview.insertCSS(`
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
      ::-webkit-scrollbar-corner { background: transparent; }
      * { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.15) transparent; }
    `).catch(() => {});
  });

  webview.addEventListener('did-navigate', (e) => {
    urlDisplay.textContent = e.url;
  });

  webview.addEventListener('permissionrequest', (e) => {
    if (e.permission === 'media' || e.permission === 'mediaKeySystemAccess') {
      e.request.allow();
    } else {
      e.request.deny();
    }
  });

  navItems.forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      welcomeScreen.style.display = 'none';
      urlDisplay.textContent = item.dataset.url;
      serviceName.textContent = providerNames[item.dataset.provider] || '';
      overlayLocation.textContent = providerNames[item.dataset.provider] || '';
      if (webviewReady) {
        webview.loadURL(item.dataset.url);
      } else {
        pendingNav = item.dataset.url;
      }
    });
  });

  let pipActive = false;

  pipBtn.addEventListener('click', () => {
    const url = webview.getURL();
    if (!url || url === 'about:blank') return;
    window.electronAPI.togglePip(url);
  });

  window.electronAPI.onPipState((state) => {
    pipActive = state;
    pipBtn.classList.toggle('active', state);
  });

  backBtn.addEventListener('click', () => webview.goBack());
  forwardBtn.addEventListener('click', () => webview.goForward());
  reloadBtn.addEventListener('click', () => webview.reload());
});
