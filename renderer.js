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
const modalCancel = document.getElementById('modalCancel');
const modalSave = document.getElementById('modalSave');
const inputName = document.getElementById('inputName');
const inputUrl = document.getElementById('inputUrl');
const inputIcon = document.getElementById('inputIcon');
const inputColor = document.getElementById('inputColor');

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

    const iconSrc = svc.icon && (svc.icon.startsWith('http://') || svc.icon.startsWith('https://'))
      ? svc.icon
      : `assets/icons/${svc.icon || 'default.png'}`;

    css += `.nav-icon.${svc.id} { --icon-bg: ${svc.color}33; --icon-border: ${svc.color}80; }\n`;
    css += `.nav-item.active.${svc.id} .nav-icon { border-color: ${svc.color}; --active-glow: ${svc.color}99; }\n`;

    btn.innerHTML = `<span class="nav-icon ${svc.id}">
        <img src="${iconSrc}" alt="${svc.name}" loading="lazy">
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
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const btn = nav.querySelector(`.nav-item[data-provider="${svc.id}"]`);
  if (btn) btn.classList.add('active');
  welcomeScreen.style.display = 'none';
  overlayLocation.textContent = svc.name;
  if (webviewReady) {
    webview.loadURL(svc.url);
  } else {
    pendingNav = svc.url;
  }
}

function getCurrentSvc() {
  return services.find(s => s.id === currentProvider) || null;
}

// Modal
function openModal() {
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

function saveService() {
  const name = inputName.value.trim();
  const url = inputUrl.value.trim();
  const icon = inputIcon.value.trim();
  const color = inputColor.value;

  if (!name || !url) return;

  const svc = { name, url, color };
  if (icon) svc.icon = icon;

  window.electronAPI.addService(svc).then(() => {
    closeModal();
  });
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

addBtn.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
modalCancel.addEventListener('click', closeModal);
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

// Services laden
window.electronAPI.getServices().then((svcs) => {
  services = svcs;
  renderNav();
});

window.electronAPI.onServicesChanged((svcs) => {
  services = svcs;
  renderNav();
  // Re-activate current provider if still present
  if (currentProvider && services.find(s => s.id === currentProvider)) {
    const btn = nav.querySelector(`.nav-item[data-provider="${currentProvider}"]`);
    if (btn) btn.classList.add('active');
  } else {
    currentProvider = '';
    overlayLocation.textContent = 'Startseite';
  }
});
