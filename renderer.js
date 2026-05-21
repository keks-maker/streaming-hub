document.addEventListener('DOMContentLoaded', () => {
  const navItems = document.querySelectorAll('.nav-item');
  const overlayBar = document.getElementById('overlayBar');
  const toolbar = document.getElementById('toolbar');
  const contentArea = document.getElementById('contentArea');
  const welcomeScreen = document.getElementById('welcomeScreen');
  const overlayLocation = document.getElementById('overlayLocation');
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

  const uaMap = { linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36', darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36', win32: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36' };
  const chromeUA = uaMap[process.platform] || uaMap.linux;

  let webviewReady = false;
  let pendingNav = null;

  webview.addEventListener('did-attach', () => {
    webviewReady = true;

    // Override User-Agent for every request (before any page script runs)
    const filter = { urls: ['*://*/*'] };
    webview.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      details.requestHeaders['User-Agent'] = chromeUA;
      callback({ requestHeaders: details.requestHeaders });
    });

    if (pendingNav) {
      webview.loadURL(pendingNav);
      pendingNav = null;
    }
  });

  webview.addEventListener('destroyed', () => {
    webview.session?.webRequest.onBeforeSendHeaders(null);
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

  webview.addEventListener('did-navigate', () => {});

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


});
