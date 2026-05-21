let services = [];
let webviewReady = false;
let pendingNav = null;
let pipActive = false;
let currentProvider = '';

const nav = document.getElementById('overlayNav');
const webview = document.getElementById('contentView');
const welcomeScreen = document.getElementById('welcomeScreen');
const overlayLocation = document.getElementById('overlayLocation');
const pipBtn = document.getElementById('pipBtn');
const addBtn = document.getElementById('addBtn');
const modalOverlay = document.getElementById('modalOverlay');
const modalClose = document.getElementById('modalClose');
const modalSave = document.getElementById('modalSave');
const serviceList = document.getElementById('serviceList');
const inputName = document.getElementById('inputName');
const inputUrl = document.getElementById('inputUrl');
const inputIcon = document.getElementById('inputIcon');
const inputColor = document.getElementById('inputColor');
const shortcutsOverlay = document.getElementById('shortcutsOverlay');
const historyOverlay = document.getElementById('historyOverlay');
const historyBtn = document.getElementById('historyBtn');
const historyList = document.getElementById('historyList');
const historyClose = document.getElementById('historyClose');
const historyClear = document.getElementById('historyClear');

const uaMap = {
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  win32: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
};
const chromeUA = uaMap[window.electronAPI.platform] || uaMap.linux;

// Generate welcome-screen background logos
const bg = document.getElementById('welcomeBg');
const iconNames = ['netflix', 'youtube', 'disney', 'prime', 'twitch', 'spotify'];
if (bg) {
  for (let i = 0; i < 20; i++) {
    const img = document.createElement('img');
    img.className = 'bg-logo';
    img.src = `assets/icons/${iconNames[i % iconNames.length]}.png`;
    img.alt = '';
    img.style.cssText = [
      `top:${(Math.random() * 90 + 2).toFixed(0)}%`,
      `left:${(Math.random() * 88 + 2).toFixed(0)}%`,
      `rotate:${(Math.random() * 70 - 35).toFixed(0)}deg`,
      `scale:${(Math.random() * 0.8 + 1).toFixed(1)}`,
      `opacity:${(Math.random() * 0.1 + 0.18).toFixed(2)}`,
    ].join(';');
    bg.appendChild(img);
  }
}

function getIconSrc(svc) {
  if (svc.icon) {
    if (svc.icon.startsWith('http://') || svc.icon.startsWith('https://')) return svc.icon;
    return `assets/icons/${svc.icon}`;
  }
  try {
    const domain = new URL(svc.url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  } catch {
    return 'assets/icons/default.png';
  }
}

function renderNav() {
  nav.innerHTML = '';
  const styleEl = document.getElementById('dynamic-service-styles') || (() => {
    const s = document.createElement('style');
    s.id = 'dynamic-service-styles';
    document.head.appendChild(s);
    return s;
  })();
  let css = '';

  services.forEach(svc => {
    const btn = document.createElement('button');
    btn.className = 'nav-item';
    btn.dataset.provider = svc.id;
    btn.dataset.url = svc.url;

    css += `.nav-icon.${svc.id} { --icon-bg: ${svc.color}33; --icon-border: ${svc.color}80; }\n`;
    css += `.nav-item.active.${svc.id} .nav-icon { border-color: ${svc.color}; --active-glow: ${svc.color}99; }\n`;

    btn.innerHTML = `<span class="nav-icon ${svc.id}">
        <img src="${getIconSrc(svc)}" alt="${svc.name}" loading="lazy">
      </span>`;

    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      navigateTo(svc);
    });

    nav.appendChild(btn);
  });

  styleEl.textContent = css;
}

function navigateTo(svc) {
  currentProvider = svc.id;
  lastMediaTitle = '';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const btn = nav.querySelector(`.nav-item[data-provider="${svc.id}"]`);
  if (btn) btn.classList.add('active');
  welcomeScreen.style.display = 'none';
  overlayLocation.textContent = svc.name;
  const targetUrl = normalizeUrl(svc.url);
  if (webviewReady) {
    try { webview.loadURL(targetUrl); } catch (e) { console.warn('loadURL failed:', targetUrl, e); }
  } else {
    pendingNav = targetUrl;
  }
}

function getCurrentSvc() {
  return services.find(s => s.id === currentProvider) || null;
}

function navigateRelative(dir) {
  if (!services.length) return;
  const idx = services.findIndex(s => s.id === currentProvider);
  const next = (idx + dir + services.length) % services.length;
  navigateTo(services[next]);
}

// Service list in modal
function renderServiceList() {
  serviceList.innerHTML = '';
  if (!services.length) {
    serviceList.innerHTML = '<div class="service-list-empty">Keine Dienste konfiguriert.</div>';
    return;
  }
  services.forEach(svc => {
    const row = document.createElement('div');
    row.className = 'service-row';

    const iconSrc = getIconSrc(svc);
    const color = svc.color || '#6c5ce7';

    row.innerHTML = `
      <img class="service-row-icon" src="${iconSrc}" alt="" style="background:${color}33;border-color:${color}66">
      <span class="service-row-name">${svc.name}</span>
      <button class="service-row-remove" data-id="${svc.id}" title="Entfernen">&times;</button>
    `;

    row.querySelector('.service-row-remove').addEventListener('click', () => {
      window.electronAPI.removeService(svc.id);
    });

    serviceList.appendChild(row);
  });
}

// Modal
function openModal() {
  renderServiceList();
  inputName.value = '';
  inputUrl.value = '';
  inputIcon.value = '';
  inputColor.value = '#6c5ce7';
  modalOverlay.classList.add('open');
  inputName.focus();
}

function closeModal() {
  modalOverlay.classList.remove('open');
}

function normalizeUrl(u) {
  u = u.trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function saveService() {
  const name = inputName.value.trim();
  const url = normalizeUrl(inputUrl.value);
  const icon = inputIcon.value.trim();
  const color = inputColor.value;

  if (!name || !url) return;

  const svc = { name, url, color };
  if (icon) svc.icon = icon;

  window.electronAPI.addService(svc).then(() => {
    closeModal();
  });
}

// Shortcuts overlay
function toggleShortcuts() {
  const isOpen = shortcutsOverlay.classList.toggle('open');
  if (!isOpen) shortcutsOverlay.classList.remove('open');
}

// History overlay
function formatTS(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function renderHistory(entries) {
  historyList.innerHTML = '';
  if (!entries || entries.length === 0) {
    historyList.innerHTML = '<div class="history-empty">Noch keine Einträge.</div>';
    return;
  }
  for (const e of entries) {
    const svc = services.find(s => s.id === e.serviceKey);
    const color = svc ? svc.color : '#6c5ce7';
    const svcName = svc ? svc.name : e.serviceName || e.serviceKey;

    const row = document.createElement('div');
    row.className = 'history-entry';

    const dot = document.createElement('span');
    dot.className = 'history-entry-dot';
    dot.style.background = color;
    row.appendChild(dot);

    const body = document.createElement('div');
    body.className = 'history-entry-body';
    body.innerHTML = `
      <div class="history-entry-title">${escapeHtml(e.title)}</div>
      <div class="history-entry-meta">${escapeHtml(svcName)} · ${formatTS(e.timestamp)}</div>
    `;
    row.appendChild(body);

    row.addEventListener('click', () => {
      closeHistory();
      if (svc) navigateTo(svc);
    });

    historyList.appendChild(row);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function openHistory() {
  window.electronAPI.getHistory().then(renderHistory);
  historyOverlay.classList.add('open');
}

function closeHistory() {
  historyOverlay.classList.remove('open');
}

function toggleHistory() {
  if (historyOverlay.classList.contains('open')) {
    closeHistory();
  } else {
    openHistory();
  }
}

// Webview events
webview.addEventListener('did-attach', () => {
  webviewReady = true;

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
  scheduleMediaCheck();
});

webview.addEventListener('did-navigate', () => {
  const url = webview.getURL();
  for (const svc of services) {
    if (url.includes(svc.id) || url.startsWith(svc.url)) {
      overlayLocation.textContent = svc.name;
      currentProvider = svc.id;
      break;
    }
  }
});

webview.addEventListener('permissionrequest', (e) => {
  if (e.permission === 'media' || e.permission === 'mediaKeySystemAccess') {
    e.request.allow();
  } else {
    e.request.deny();
  }
});

// Media Session title → save to history (poll via executeJavaScript)
let lastMediaTitle = '';
function pollMediaTitle() {
  const svc = getCurrentSvc();
  if (!svc) return;
  webview.executeJavaScript('navigator.mediaSession?.metadata?.title || ""')
    .then((title) => {
      if (title && title !== lastMediaTitle) {
        lastMediaTitle = title;
        window.electronAPI.saveHistoryEntry({ title, serviceKey: svc.id, serviceName: svc.name });
      }
    })
    .catch(() => {});
}

// Quick check after page load (setTimeout to wait for SPA title)
function scheduleMediaCheck() {
  setTimeout(pollMediaTitle, 2000);
}

setInterval(pollMediaTitle, 3000);

// Buttons
pipBtn.addEventListener('click', () => {
  const url = webview.getURL();
  if (!url || url === 'about:blank') return;
  window.electronAPI.togglePip(url);
});

window.electronAPI.onPipState((state) => {
  pipActive = state;
  pipBtn.classList.toggle('active', state);
});

historyBtn.addEventListener('click', toggleHistory);
historyClose.addEventListener('click', closeHistory);
historyOverlay.addEventListener('click', (e) => {
  if (e.target === historyOverlay) closeHistory();
});
historyClear.addEventListener('click', () => {
  window.electronAPI.clearHistory().then(renderHistory);
});

addBtn.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});
modalSave.addEventListener('click', saveService);

inputName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') inputUrl.focus();
});
inputUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') inputIcon.focus();
});
inputIcon.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveService();
});

// Keyboard shortcut handler (shared for document + webview forwarding)
function handleKeyShortcut(key, ctrlKey, shiftKey, metaKey) {
  if (key === 'Escape') {
    if (shortcutsOverlay.classList.contains('open')) {
      shortcutsOverlay.classList.remove('open');
      return true;
    }
    if (modalOverlay.classList.contains('open')) {
      closeModal();
      return true;
    }
    if (historyOverlay.classList.contains('open')) {
      closeHistory();
      return true;
    }
    return true;
  }

  if (key === '?' && !ctrlKey && !metaKey) {
    toggleShortcuts();
    return true;
  }

  if (key === 'F11') {
    window.electronAPI.toggleFullscreen();
    return true;
  }

  if (ctrlKey && key === 'Tab') {
    navigateRelative(shiftKey ? -1 : 1);
    return true;
  }

  if (ctrlKey && (key === 'p' || key === 'P')) {
    const url = webview.getURL();
    if (url && url !== 'about:blank') {
      window.electronAPI.togglePip(url);
    }
    return true;
  }

  if (ctrlKey && (key === 'h' || key === 'H')) {
    toggleHistory();
    return true;
  }

  return false;
}

document.addEventListener('keydown', (e) => {
  // Skip when typing in inputs (except Escape which is handled by webview forward)
  if (e.target.tagName === 'INPUT') {
    if (e.key === 'Escape') {
      if (shortcutsOverlay.classList.contains('open')) {
        shortcutsOverlay.classList.remove('open');
        e.preventDefault();
      } else if (modalOverlay.classList.contains('open')) {
        closeModal();
        e.preventDefault();
      } else if (historyOverlay.classList.contains('open')) {
        closeHistory();
        e.preventDefault();
      }
    }
    return;
  }
  if (handleKeyShortcut(e.key, e.ctrlKey, e.shiftKey, e.metaKey)) {
    e.preventDefault();
  }
});

// Forwarded shortcuts from webview (via main process)
const cleanupShortcuts = window.electronAPI.onWebviewKeydown((data) => {
  handleKeyShortcut(data.key, data.ctrlKey, data.shiftKey, data.metaKey);
});

// Global media keys → webview Media Session
window.electronAPI.onMediaKey((action) => {
  const cmds = {
    playpause: 'navigator.mediaSession.playPause()',
    nexttrack: 'navigator.mediaSession.nextTrack()',
    previoustrack: 'navigator.mediaSession.previousTrack()',
    stop: 'navigator.mediaSession.stop()',
  };
  const cmd = cmds[action];
  if (cmd && webviewReady && webview.getURL() !== 'about:blank') {
    webview.executeJavaScript(cmd).catch(() => {});
  }
});

// Version anzeigen
window.electronAPI.getAppVersion().then((v) => {
  document.getElementById('versionTag').textContent = 'v' + v;
});

// Services laden
window.electronAPI.getServices().then((svcs) => {
  services = svcs;
  renderNav();
});

window.electronAPI.onServicesChanged((svcs) => {
  services = svcs;
  renderNav();
  renderServiceList();
  if (currentProvider && services.find(s => s.id === currentProvider)) {
    const btn = nav.querySelector(`.nav-item[data-provider="${currentProvider}"]`);
    if (btn) btn.classList.add('active');
  } else {
    currentProvider = '';
    overlayLocation.textContent = 'Startseite';
  }
});
