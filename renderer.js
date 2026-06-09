// v0.3.7. – Kanalwechsel per postMessage (kein Vollbild-Ende) + Reihenfolge = Sidebar
const {
  escapeHtml,
  decodeEntities,
  normalizeUrl,
  formatTimestamp,
  parseEpgTime,
  formatEpgTime,
  buildEpgIndex,
  getEpgChannelList,
  getMediathekForChannel,
  isFavorite,
  buildChannelList,
  filterChannels,
  groupChannels,
  separateFavorites,
  applyChannelOverrides,
  applySortOrder,
} = require('@streaming-hub/typed-core');
const logger = require('./logger.js');

let services = [];
let webviewReady = false;
let pendingNav = null;
let pipActive = false;
let currentProvider = '';

// TV state
let tvSources = [];
let tvChannels = [];
let tvEpgData = [];
let tvSidebarOpen = false;
let tvActiveChannelId = null;
let tvSearchFilter = '';
let tvSelectedSourceIds = [];
let tvCollapsedGroups = {};
let tvEpgRefreshing = false;
let tvEpgIndex = null; // Map<normId, epgEntry[]> für schnelle EPG-Lookups
let tvChOverrides = {}; // {sourceId: {chId: {name?,url?,tvgId?,tvgLogo?}}} – ungespeicherte Änderungen
let tvChDirty = false;

const overlayBar = document.getElementById('overlayBar');
const nav = document.getElementById('overlayNav');
let tvBtn = null;
const contentView = document.getElementById('contentView');
const tvView = document.getElementById('tvView');
let webview = contentView;
let tvViewReady = false;

function switchWebview(useTv) {
  if (useTv) {
    // Streaming-Player pausieren beim Wechsel zu TV
    try {
      contentView.executeJavaScript(`document.querySelectorAll('video,audio').forEach(function(e){e.pause()})`);
    } catch (_e) {}
    contentView.style.opacity = '0';
    contentView.style.pointerEvents = 'none';
    tvView.style.opacity = '1';
    tvView.style.pointerEvents = '';
    webview = tvView;
  } else {
    // TV-Stream stoppen via about:blank (räumt HLS.js + Video in der IIFE auf)
    try {
      tvView.loadURL('about:blank');
    } catch (_e) {
      /* tvView noch nicht geladen */
    }
    tvView.style.opacity = '0';
    tvView.style.pointerEvents = 'none';
    contentView.style.opacity = '';
    contentView.style.pointerEvents = '';
    webview = contentView;
  }
}

// ── Error Overlay ──
const errorOverlay = document.getElementById('errorOverlay');
const errorMsg = document.getElementById('errorMsg');
const errorReloadBtn = document.getElementById('errorReloadBtn');
let errorUrl = null;

function showError(message, url) {
  if (!errorOverlay) return;
  errorMsg.textContent = message;
  errorUrl = url || null;
  errorOverlay.style.display = '';
}

function hideError() {
  if (!errorOverlay) return;
  errorOverlay.style.display = 'none';
  errorUrl = null;
}

errorReloadBtn.addEventListener('click', () => {
  hideError();
  if (errorUrl && webviewReady) {
    webview.loadURL(errorUrl);
  } else if (webviewReady) {
    webview.reload();
  }
});

const welcomeScreen = document.getElementById('welcomeScreen');
const overlayLocation = document.getElementById('overlayLocation');
const pipBtn = document.getElementById('pipBtn');
const shortcutsOverlay = document.getElementById('shortcutsOverlay');
const historyOverlay = document.getElementById('historyOverlay');
const historyBtn = document.getElementById('historyBtn');
const historyList = document.getElementById('historyList');
const historyClose = document.getElementById('historyClose');
const historyClear = document.getElementById('historyClear');

// TV DOM references
const tvSidebar = document.getElementById('tvSidebar');
const tvSidebarTrigger = document.getElementById('tvSidebarTrigger');

const tvSidebarManage = document.getElementById('tvSidebarManage');
const tvSidebarEpgRefresh = document.getElementById('tvSidebarEpgRefresh');
const tvSidebarSources = document.getElementById('tvSidebarSources');
const tvSidebarChannels = document.getElementById('tvSidebarChannels');
const tvSidebarStatus = document.getElementById('tvSidebarStatus');
const tvSearchInput = document.getElementById('tvSearchInput');
const tvModalOverlay = document.getElementById('tvModalOverlay');
const tvModalClose = document.getElementById('tvModalClose');
const tvModalSave = document.getElementById('tvModalSave');
const tvSourceList = document.getElementById('tvSourceList');
const tvInputName = document.getElementById('tvInputName');
const tvInputUrl = document.getElementById('tvInputUrl');
const tvInputEpgUrl = document.getElementById('tvInputEpgUrl');
const tvInputColor = document.getElementById('tvInputColor');
const tvFileBtn = document.getElementById('tvFileBtn');
const tvSidebarEdit = document.getElementById('tvSidebarEdit');
const tvChModalOverlay = document.getElementById('tvChModalOverlay');
const tvChModalClose = document.getElementById('tvChModalClose');
const tvChModalSave = document.getElementById('tvChModalSave');
const tvChList = document.getElementById('tvChList');
const tvChSearch = document.getElementById('tvChSearch');

// EPG Overlay DOM
const epgOverlay = document.getElementById('epgOverlay');
const epgBody = document.getElementById('epgBody');
const epgRangeLabel = document.getElementById('epgRangeLabel');
const epgCloseBtn = document.getElementById('epgCloseBtn');
const epgRefreshBtn = document.getElementById('epgRefreshBtn');
const epgDetailBackdrop = document.getElementById('epgDetailBackdrop');
const epgDetailTitle = document.getElementById('epgDetailTitle');
const epgDetailMeta = document.getElementById('epgDetailMeta');
const epgDetailDesc = document.getElementById('epgDetailDesc');
const epgDetailActions = document.getElementById('epgDetailActions');
const epgDetailClose = document.getElementById('epgDetailClose');
const tvSidebarEpgBtn = document.getElementById('tvSidebarEpgBtn');

let epgSlotHours = 8;

// Mediathek mapping for EPG -> service search (now in typed-core tv.ts)
const tvChStatus = document.getElementById('tvChStatus');

const chromeVer = window.electronAPI.chromeVersion || '148.0.0.0';
const uaMap = {
  linux: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`,
  darwin: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`,
  win32: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`,
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
  const styleEl =
    document.getElementById('dynamic-service-styles') ||
    (() => {
      const s = document.createElement('style');
      s.id = 'dynamic-service-styles';
      document.head.appendChild(s);
      return s;
    })();
  let css = '';

  const groups = [
    { key: 'livetv', label: 'LiveTV' },
    { key: 'streaming', label: 'Streaming' },
    { key: 'mediathek', label: 'Mediatheken' },
  ];

  groups.forEach((group, gi) => {
    if (group.key === 'livetv') {
      if (gi > 0) {
        nav.appendChild(createDivider());
      }
      nav.appendChild(createGroupLabel(group.label));

      const btn = document.createElement('button');
      btn.className = 'nav-item';
      btn.id = 'tvBtn';
      btn.dataset.provider = '__tv__';
      btn.innerHTML = `<span class="nav-icon nav-tv-icon">
        <img src="assets/icons/tv-icon.png" alt="TV" draggable="false">
      </span>`;
      btn.addEventListener('mousedown', e => {
        e.preventDefault();
        toggleTvSidebar();
      });
      nav.appendChild(btn);
      return;
    }

    const items = services.filter(s => (s.group || 'streaming') === group.key);
    if (!items.length) return;

    if (gi > 0) {
      nav.appendChild(createDivider());
    }
    nav.appendChild(createGroupLabel(group.label));

    items.forEach(svc => {
      const btn = document.createElement('button');
      btn.className = 'nav-item';
      btn.dataset.provider = svc.id;
      btn.dataset.url = svc.url;

      css += `.nav-icon.${svc.id} { --icon-bg: ${svc.color}33; }\n`;
      css += `.nav-item.active.${svc.id} .nav-icon { --active-glow: ${svc.color}99; }\n`;

      btn.innerHTML = `<span class="nav-icon ${svc.id}">
          <img src="${getIconSrc(svc)}" alt="${svc.name}" loading="lazy">
        </span>`;

      btn.addEventListener('mousedown', e => {
        e.preventDefault();
        navigateTo(svc);
      });

      nav.appendChild(btn);
    });
  });

  styleEl.textContent = css;
}

function createDivider() {
  const d = document.createElement('div');
  d.className = 'nav-divider';
  return d;
}

function createGroupLabel(text) {
  const l = document.createElement('span');
  l.className = 'nav-group-label';
  l.textContent = text;
  return l;
}

function goToStartPage() {
  currentProvider = '';
  lastMediaTitle = '';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  switchWebview(false);
  welcomeScreen.style.display = '';
  overlayBar.classList.add('always-visible');
  if (webviewReady) {
    try {
      webview.loadURL('about:blank');
    } catch (e) {
      logger.warn('loadURL failed');
    }
  }
  if (tvSources.length && !tvSidebarOpen) openTvSidebar();
}

function navigateTo(svc) {
  currentProvider = svc.id;
  lastMediaTitle = '';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const btn = nav.querySelector(`.nav-item[data-provider="${svc.id}"]`);
  if (btn) btn.classList.add('active');
  switchWebview(false);
  welcomeScreen.style.display = 'none';
  overlayBar.classList.remove('always-visible');
  const targetUrl = normalizeUrl(svc.url);
  if (webviewReady) {
    try {
      webview.loadURL(targetUrl);
    } catch (e) {
      logger.warn('loadURL failed:', targetUrl, e);
    }
  } else {
    pendingNav = targetUrl;
  }
  if (tvSidebarOpen) closeTvSidebar();
}

function getCurrentSvc() {
  return services.find(s => s.id === currentProvider) || null;
}

function navigateRelative(dir) {
  if (!services.length) return;
  // If in TV mode, navigate to first/last service
  if (currentProvider === '__tv__') {
    navigateTo(dir > 0 ? services[0] : services[services.length - 1]);
    return;
  }
  const idx = services.findIndex(s => s.id === currentProvider);
  const next = (idx + dir + services.length) % services.length;
  navigateTo(services[next]);
}

// ── Settings: Service Management ──

function renderSettingsServices() {
  const streamingList = document.getElementById('settingsServiceListStreaming');
  const mediathekList = document.getElementById('settingsServiceListMediathek');
  if (!streamingList || !mediathekList) return;

  const streaming = services.filter(s => (s.group || 'streaming') === 'streaming');
  const mediathek = services.filter(s => s.group === 'mediathek');

  function renderList(container, items) {
    container.innerHTML = '';
    if (!items.length) {
      container.innerHTML = '<div class="service-list-empty">Keine Dienste.</div>';
      return;
    }
    items.forEach(svc => {
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
      container.appendChild(row);
    });
  }

  renderList(streamingList, streaming);
  renderList(mediathekList, mediathek);
}

// ── Settings: Add Service Form ──

const settingsAddDienstBtn = document.getElementById('settingsAddDienstBtn');
const settingsAddForm = document.getElementById('settingsAddForm');
const settingsInputName = document.getElementById('settingsInputName');
const settingsInputUrl = document.getElementById('settingsInputUrl');
const settingsInputIcon = document.getElementById('settingsInputIcon');
const settingsInputColor = document.getElementById('settingsInputColor');
const settingsInputGroup = document.getElementById('settingsInputGroup');
const settingsAddSave = document.getElementById('settingsAddSave');

settingsAddDienstBtn.addEventListener('click', () => {
  const isOpen = settingsAddForm.style.display !== 'none';
  settingsAddForm.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    settingsInputName.value = '';
    settingsInputUrl.value = '';
    settingsInputIcon.value = '';
    settingsInputColor.value = '#6c5ce7';
    settingsInputName.focus();
  }
});

settingsInputName.addEventListener('keydown', e => {
  if (e.key === 'Enter') settingsInputUrl.focus();
});
settingsInputUrl.addEventListener('keydown', e => {
  if (e.key === 'Enter') settingsInputIcon.focus();
});
settingsInputIcon.addEventListener('keydown', e => {
  if (e.key === 'Enter') settingsAddSave.click();
});

function saveSettingsService() {
  const name = settingsInputName.value.trim();
  const url = normalizeUrl(settingsInputUrl.value);
  const icon = settingsInputIcon.value.trim();
  const color = settingsInputColor.value;
  const group = settingsInputGroup.value;

  if (!name || !url) return;

  const svc = { name, url, color, group };
  if (icon) svc.icon = icon;

  window.electronAPI.addService(svc).then(() => {
    settingsInputName.value = '';
    settingsInputUrl.value = '';
    settingsInputIcon.value = '';
    settingsInputColor.value = '#6c5ce7';
    settingsAddForm.style.display = 'none';
  });
}

settingsAddSave.addEventListener('click', saveSettingsService);

// ── TV Sources Modal ──

function openTvModal() {
  renderTvSourceList();
  tvInputName.value = '';
  tvInputUrl.value = '';
  tvInputEpgUrl.value = '';
  tvInputColor.value = '#a78bfa';
  tvModalOverlay.classList.add('open');
  tvInputName.focus();
}

function closeTvModal() {
  tvModalOverlay.classList.remove('open');
}

function renderTvSourceList() {
  tvSourceList.innerHTML = '';
  if (!tvSources.length) {
    tvSourceList.innerHTML = '<div class="service-list-empty">Keine TV-Quellen konfiguriert.</div>';
    return;
  }
  tvSources.forEach(src => {
    const row = document.createElement('div');
    row.className = 'tv-source-row';

    const typeLabel = src.type === 'file' ? '📄' : '🌐';

    row.innerHTML = `
      <span class="tv-source-row-icon">${typeLabel}</span>
      <div class="tv-source-row-info" style="flex:1;min-width:0">
        <div class="tv-source-row-name">${escapeHtml(src.name)}</div>
        <div class="tv-source-row-meta">${escapeHtml(src.type === 'file' ? src.url.split('/').pop() : src.url)}</div>
      </div>
      <button class="tv-source-row-remove" data-id="${src.id}" title="Entfernen">&times;</button>
    `;

    row.querySelector('.tv-source-row-remove').addEventListener('click', () => {
      window.electronAPI.removeTvSource(src.id);
    });

    tvSourceList.appendChild(row);
  });
}

function saveTvSource() {
  const name = tvInputName.value.trim();
  const url = tvInputUrl.value.trim();
  const epgUrl = tvInputEpgUrl.value.trim();

  if (!name || !url) return;

  const isFile = url.startsWith('/') || url.startsWith('./') || url.startsWith('../') || /^[A-Z]:\\/i.test(url);
  const color = tvInputColor.value;
  const source = { name, url, type: isFile ? 'file' : 'url', color, epgUrl: epgUrl || null };
  window.electronAPI.addTvSource(source).then(() => {
    closeTvModal();
  });
}

// ── TV Sidebar ──

function toggleTvSidebar() {
  if (tvSidebarOpen) {
    closeTvSidebar();
  } else {
    openTvSidebar();
  }
}

function openTvSidebar() {
  tvSidebarOpen = true;
  tvSidebar.classList.add('open');
  if (tvBtn) tvBtn.classList.add('active');

  // Restore collapsed groups from localStorage
  try {
    const saved = localStorage.getItem('tv-collapsed-groups');
    if (saved) tvCollapsedGroups = JSON.parse(saved);
  } catch {}

  // If no sources selected, select all
  if (!tvSelectedSourceIds.length && tvSources.length) {
    tvSelectedSourceIds = tvSources.map(s => s.id);
  }

  renderSourcePills();
  loadTvChannels();
}

function closeTvSidebar() {
  tvSidebarOpen = false;
  tvSidebar.classList.remove('open');
  if (tvBtn) tvBtn.classList.remove('active');
}

function loadTvChannels(forceReload) {
  // Cache: nicht erneut laden wenn Daten bereits vorhanden
  if (!forceReload && tvChannels.length > 0) {
    renderTvChannels();
    return;
  }
  tvSidebarChannels.innerHTML = '<div class="tv-sidebar-empty">Lade Sender...</div>';
  tvChannels = [];

  if (!tvSources.length) {
    tvSidebarChannels.innerHTML =
      '<div class="tv-sidebar-empty">Keine Sender geladen.<br>Füge eine TV-Quelle hinzu.</div>';
    tvSidebarStatus.textContent = 'Keine Quellen';
    return;
  }

  tvSidebarStatus.textContent = tvSources.map(s => s.name).join(', ');
  const parsePromises = [];
  const sourceChannelMap = {}; // sourceId → channels[]

  tvSources.forEach(source => {
    const p = window.electronAPI
      .fetchAndParseM3U(source.url)
      .then(result => {
        const tagged = result.channels.map(ch => ({ ...ch, sourceId: source.id }));
        sourceChannelMap[source.id] = tagged;
        source.baseUrl = result.baseUrl || ''; // für relative Logo-Auflösung in Overrides
        tvChannels = tvChannels.concat(tagged);
      })
      .catch(err => {
        logger.warn('Fehler beim Laden von', source.name, err.message);
        sourceChannelMap[source.id] = [];
      });
    parsePromises.push(p);
  });

  Promise.all(parsePromises).then(() => {
    // Apply channel overrides + sort order via typed-core
    tvChannels = [];
    tvSources.forEach(source => {
      let srcChannels = sourceChannelMap[source.id] || [];
      srcChannels = applyChannelOverrides(srcChannels, source);
      if (source.sortOrder && source.sortOrder.length) {
        srcChannels = applySortOrder(srcChannels, source.sortOrder);
      }
      tvChannels = tvChannels.concat(srcChannels);
    });

    renderTvChannels();
    updateEpgStatus();
  });
}

function updateEpgStatus() {
  if (tvEpgIndex && tvEpgData.length) {
    tvSidebarStatus.textContent = tvSources.map(s => s.name).join(', ') + ' | EPG: ' + tvEpgIndex.size + ' Kanäle';
  } else {
    const hasEpgConfig = tvSources.some(s => s.epgUrl);
    tvSidebarStatus.innerHTML =
      tvSources.map(s => s.name).join(', ') +
      (hasEpgConfig ? ' | <span class="tv-epg-loading">EPG lädt…</span>' : ' | Keine EPG-URL');
  }
}

function loadEpgData() {
  const urls = [...new Set(tvSources.map(s => s.epgUrl).filter(Boolean))];
  if (!urls.length) {
    if (tvSidebarOpen) updateEpgStatus();
    return;
  }
  if (tvSidebarOpen) updateEpgStatus();
  Promise.all(urls.map(url => window.electronAPI.fetchEPG(url).catch(() => []))).then(results => {
    tvEpgData = results.flat();
    tvEpgIndex = buildEpgIndex(tvEpgData);
    if (tvSidebarOpen) {
      tvSidebarStatus.innerHTML =
        tvSources.map(s => s.name).join(', ') + ' | <span style="color:#4ade80">EPG geladen ✓</span>';
      setTimeout(() => updateEpgStatus(), 2000);
      renderTvChannels();
    }
  });
}

function renderSourcePills() {
  tvSidebarSources.innerHTML = '';
  tvSources.forEach(src => {
    const pill = document.createElement('span');
    const isActive = tvSelectedSourceIds.includes(src.id);
    pill.className = 'tv-source-pill' + (isActive ? ' active' : '');
    pill.innerHTML = `<span class="tv-source-pill-dot" style="background:${src.color || '#a78bfa'}"></span>${escapeHtml(src.name)}`;
    pill.addEventListener('click', () => toggleSource(src.id));
    tvSidebarSources.appendChild(pill);
  });
}

function toggleSource(sourceId) {
  const idx = tvSelectedSourceIds.indexOf(sourceId);
  if (idx !== -1) {
    if (tvSelectedSourceIds.length > 1) {
      tvSelectedSourceIds.splice(idx, 1);
    }
  } else {
    tvSelectedSourceIds.push(sourceId);
  }
  renderSourcePills();
  renderTvChannels();
}

function toggleFavorite(ch) {
  const source = tvSources.find(s => s.id === ch.sourceId);
  if (!source) return;
  if (!source.favorites) source.favorites = [];
  const fIdx = source.favorites.indexOf(ch.id);
  if (fIdx !== -1) {
    source.favorites.splice(fIdx, 1);
  } else {
    source.favorites.push(ch.id);
  }
  window.electronAPI.updateTvSource(source.id, { favorites: source.favorites });
  renderTvChannels();
}

function refreshEpg() {
  if (tvEpgRefreshing) return;
  tvEpgRefreshing = true;
  tvSidebarEpgRefresh.classList.add('refreshing');

  const epgUrls = [];
  tvSources.forEach(src => {
    if (src.epgUrl && !epgUrls.includes(src.epgUrl)) epgUrls.push(src.epgUrl);
  });
  // Also check if any loaded channel EPG URLs are not in source list
  // (from x-tvg-url in M3U)

  if (!epgUrls.length) {
    tvEpgRefreshing = false;
    tvSidebarEpgRefresh.classList.remove('refreshing');
    return;
  }

  if (tvSidebarOpen) {
    tvSidebarStatus.innerHTML =
      tvSources.map(s => s.name).join(', ') + ' | <span class="tv-epg-loading">EPG lädt…</span>';
  }
  Promise.all(epgUrls.map(url => window.electronAPI.fetchEPG(url).catch(() => [])))
    .then(results => {
      tvEpgData = results.flat();
      tvEpgIndex = buildEpgIndex(tvEpgData);
      if (tvSidebarOpen) {
        tvSidebarStatus.innerHTML =
          tvSources.map(s => s.name).join(', ') + ' | <span style="color:#4ade80">EPG aktualisiert ✓</span>';
        setTimeout(() => updateEpgStatus(), 2000);
      }
      renderTvChannels();
    })
    .finally(() => {
      tvEpgRefreshing = false;
      tvSidebarEpgRefresh.classList.remove('refreshing');
    });
}

function renderTvChannelItem(ch, showFav) {
  const item = document.createElement('div');
  item.className = 'tv-channel-item' + (ch.id === tvActiveChannelId ? ' active' : '');
  item.dataset.channelId = ch.id;

  const now = new Date();
  const normId = id =>
    id
      .replace(/@[^.@]*/g, '')
      .toLowerCase()
      .trim();
  const chNorm = normId(ch.tvgId);
  let currentEpg = null;
  const epgList = tvEpgIndex && tvEpgIndex.get(chNorm);
  if (epgList) {
    currentEpg = epgList.find(e => {
      const start = parseEpgTime(e.start);
      const stop = parseEpgTime(e.stop);
      return start <= now && stop >= now;
    });
  }

  const srcIdx = tvSources.findIndex(s => s.id === ch.sourceId);
  const srcColor = srcIdx !== -1 ? tvSources[srcIdx].color || '#a78bfa' : '#a78bfa';
  const fav = isFavorite(ch, tvSources);
  const isMultiSource = tvSelectedSourceIds.length > 1;

  item.innerHTML = `
    <img class="tv-channel-logo" src="${ch.logo || ''}" alt="" onerror="this.style.display='none'" loading="lazy">
    <div class="tv-channel-info">
      <div class="tv-channel-name">
        ${isMultiSource ? `<span class="tv-channel-source-dot" style="background:${srcColor}"></span>` : ''}
        ${escapeHtml(ch.name)}
      </div>
      ${currentEpg ? `<div class="tv-channel-epg">${escapeHtml(decodeEntities(currentEpg.title))}</div>` : ''}
    </div>
    <span class="tv-channel-fav ${fav ? 'active' : ''}" title="Favorit">${fav ? '★' : '☆'}</span>
    <span class="tv-channel-drag" draggable="true">⠿</span>
  `;

  item.addEventListener('click', e => {
    if (e.target.closest('.tv-channel-drag')) return;
    if (e.target.closest('.tv-channel-fav')) {
      e.stopPropagation();
      toggleFavorite(ch);
      return;
    }
    selectTvChannel(ch, { suppressChannelList: true });
  });

  const dragHandle = item.querySelector('.tv-channel-drag');
  dragHandle.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', ch.id);
    item.classList.add('dragging');
  });
  dragHandle.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    document.querySelectorAll('.tv-channel-item.drag-over').forEach(el => el.classList.remove('drag-over'));
  });
  item.addEventListener('dragover', e => {
    e.preventDefault();
    item.classList.add('drag-over');
  });
  item.addEventListener('dragleave', () => {
    item.classList.remove('drag-over');
  });
  item.addEventListener('drop', e => {
    e.preventDefault();
    item.classList.remove('drag-over');
    const draggedId = e.dataTransfer.getData('text/plain');
    if (draggedId && draggedId !== ch.id) {
      reorderChannel(draggedId, ch.id);
    }
  });

  return item;
}

function renderTvChannels() {
  tvSidebarChannels.innerHTML = '';

  if (!tvChannels.length) {
    tvSidebarChannels.innerHTML = '<div class="tv-sidebar-empty">Keine Sender geladen.</div>';
    return;
  }

  const filtered = filterChannels(tvChannels, tvSelectedSourceIds, tvSearchFilter);

  if (!filtered.length) {
    tvSidebarChannels.innerHTML = '<div class="tv-sidebar-empty">Keine Sender gefunden.</div>';
    return;
  }

  // Separate favorites + group channels via typed-core
  const { favorites: favoriteChannels, regular: regularChannels } = separateFavorites(filtered, tvSources);
  const groups = groupChannels(regularChannels);

  const groupNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));

  // Render favorites group first (if any)
  if (favoriteChannels.length) {
    const groupEl = document.createElement('div');
    groupEl.className = 'tv-channel-group';
    const favHeader = document.createElement('div');
    favHeader.className = 'tv-channel-group-header';
    favHeader.innerHTML = `<span class="tv-channel-group-arrow">▼</span> Favoriten (${favoriteChannels.length})`;
    groupEl.appendChild(favHeader);
    const favContent = document.createElement('div');
    favContent.className = 'tv-channel-group-content';
    favoriteChannels.forEach(ch => favContent.appendChild(renderTvChannelItem(ch, true)));
    groupEl.appendChild(favContent);
    tvSidebarChannels.appendChild(groupEl);
  }

  groupNames.forEach(groupName => {
    const groupEl = document.createElement('div');
    groupEl.className = 'tv-channel-group';

    const header = document.createElement('div');
    header.className = 'tv-channel-group-header';
    if (tvCollapsedGroups[groupName]) header.classList.add('collapsed');
    const totalInGroup = tvChannels.filter(
      c => c.group === groupName && tvSelectedSourceIds.includes(c.sourceId),
    ).length;
    const showCount = groups[groupName].length;
    const countStr = showCount < totalInGroup ? `${showCount}/${totalInGroup}` : String(totalInGroup);
    header.innerHTML = `<span class="tv-channel-group-arrow">▼</span> ${escapeHtml(groupName)} (${countStr})`;
    header.addEventListener('click', () => {
      header.classList.toggle('collapsed');
      tvCollapsedGroups[groupName] = header.classList.contains('collapsed');
      try {
        localStorage.setItem('tv-collapsed-groups', JSON.stringify(tvCollapsedGroups));
      } catch {}
    });
    groupEl.appendChild(header);

    const content = document.createElement('div');
    content.className = 'tv-channel-group-content';
    if (tvCollapsedGroups[groupName]) content.style.display = 'none';

    groups[groupName].forEach(ch => content.appendChild(renderTvChannelItem(ch, false)));

    groupEl.appendChild(content);
    tvSidebarChannels.appendChild(groupEl);
  });
}

// ── TV Channel Editor ──

let tvChEditCache = []; // {ch, source}[] für die aktuelle Editor-Liste
let tvEpgChannelList = []; // [{normId, channelId, sampleTitle}] für EPG-Dropdown

function openTvChEditor() {
  tvChOverrides = {};
  tvChDirty = false;
  tvChStatus.textContent = '';
  tvEpgChannelList = getEpgChannelList(tvEpgIndex);
  if (!tvEpgChannelList.length) {
    tvChStatus.textContent = '⚠️ EPG nicht geladen – erst EPG über Sidebar laden';
    tvChStatus.style.color = '#fbbf24';
  }
  // Alle Channels aus allen Quellen sammeln
  tvChEditCache = [];
  tvSources.forEach(src => {
    const srcChannels = tvChannels.filter(c => c.sourceId === src.id);
    srcChannels.forEach(ch => tvChEditCache.push({ ch, src }));
  });
  renderTvChEditor();
  tvChModalOverlay.classList.add('open');
  tvChSearch.value = '';
  tvChSearch.focus();
}

function closeTvChEditor() {
  tvChModalOverlay.classList.remove('open');
}

function renderTvChEditor() {
  const filter = tvChSearch.value.toLowerCase().trim();
  let items = tvChEditCache;
  if (filter) {
    items = items.filter(
      ({ ch }) =>
        ch.name.toLowerCase().includes(filter) ||
        ch.tvgId.toLowerCase().includes(filter) ||
        ch.url.toLowerCase().includes(filter),
    );
  }
  tvChList.innerHTML = '';
  items.forEach(({ ch, src }) => {
    const ov = (tvChOverrides[src.id] && tvChOverrides[src.id][ch.id]) || {};
    const effName = ov.name != null ? ov.name : ch.name;
    const effUrl = ov.url != null ? ov.url : ch.url;
    const effTvgId = ov.tvgId != null ? ov.tvgId : ch.tvgId;
    const effLogo = ov.tvgLogo != null ? ov.tvgLogo : ch.logo || '';

    // EPG-Status
    const normId = id =>
      id
        .replace(/@[^.@]*/g, '')
        .toLowerCase()
        .trim();
    const epgFound = tvEpgIndex && tvEpgIndex.has(normId(effTvgId));
    const epgIcon = epgFound ? '✓' : '✗';
    const epgColor = epgFound ? '#22c55e' : '#ef4444';

    const row = document.createElement('div');
    row.className = 'tv-ch-row';
    row.innerHTML = `
      <div class="tv-ch-row-fields">
        <input class="tv-ch-input tv-ch-name" value="${escapeHtml(effName)}" placeholder="Name">
        <input class="tv-ch-input tv-ch-url" value="${escapeHtml(effUrl)}" placeholder="URL">
        <div class="tv-ch-row-meta">
          <span class="tv-ch-epg-badge" style="background:${epgColor}">EPG ${epgIcon}</span>
          <div class="tv-ch-combo">
            <input class="tv-ch-input tv-ch-tvgid" value="${escapeHtml(effTvgId)}" placeholder="tvg-id ..." autocomplete="off">
            <div class="tv-ch-combodrop"></div>
          </div>
          <input class="tv-ch-input tv-ch-logo" value="${escapeHtml(effLogo)}" placeholder="Logo-URL">
        </div>
      </div>
      <span class="tv-ch-row-src">${escapeHtml(src.name)}</span>
    `;

    const nameInp = row.querySelector('.tv-ch-name');
    const urlInp = row.querySelector('.tv-ch-url');
    const tvgInp = row.querySelector('.tv-ch-tvgid');
    const logoInp = row.querySelector('.tv-ch-logo');
    const comboDrop = row.querySelector('.tv-ch-combodrop');

    const markDirty = () => {
      tvChDirty = true;
      tvChStatus.textContent = '⚡ Ungespeicherte Änderungen';
      tvChStatus.style.color = '#fbbf24';
    };

    // EPG-Combobox: filter + dropdown
    function renderComboDropdown(query) {
      const q = query.toLowerCase().trim();
      comboDrop.innerHTML = '';
      let matched = tvEpgChannelList;
      if (q) matched = matched.filter(e => e.normId.includes(q) || e.channelId.includes(q));
      if (!matched.length) {
        comboDrop.innerHTML = '<div class="tv-ch-combo-empty">Keine EPG-Treffer</div>';
        return;
      }
      // Max 100 anzeigen
      matched.slice(0, 100).forEach(epg => {
        const item = document.createElement('div');
        item.className = 'tv-ch-combo-item';
        item.textContent = epg.channelId;
        item.title = epg.sampleTitle;
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          tvgInp.value = epg.channelId;
          comboDrop.classList.remove('open');
          if (!tvChOverrides[src.id]) tvChOverrides[src.id] = {};
          if (!tvChOverrides[src.id][ch.id]) tvChOverrides[src.id][ch.id] = {};
          tvChOverrides[src.id][ch.id].tvgId = epg.channelId;
          markDirty();
          // EPG-Badge aktualisieren
          const badge = row.querySelector('.tv-ch-epg-badge');
          badge.textContent = 'EPG ✓';
          badge.style.background = '#22c55e';
        });
        comboDrop.appendChild(item);
      });
      if (matched.length > 100) {
        const more = document.createElement('div');
        more.className = 'tv-ch-combo-empty';
        more.textContent = '... und ' + (matched.length - 100) + ' weitere';
        comboDrop.appendChild(more);
      }
    }

    tvgInp.addEventListener('input', () => {
      if (!tvChOverrides[src.id]) tvChOverrides[src.id] = {};
      if (!tvChOverrides[src.id][ch.id]) tvChOverrides[src.id][ch.id] = {};
      tvChOverrides[src.id][ch.id].tvgId = tvgInp.value || undefined;
      markDirty();
      renderComboDropdown(tvgInp.value);
      if (tvgInp.value) comboDrop.classList.add('open');
    });
    tvgInp.addEventListener('focus', () => {
      renderComboDropdown(tvgInp.value);
      comboDrop.classList.add('open');
    });
    tvgInp.addEventListener('blur', () => {
      // Verzögert schließen, damit mousedown noch feuern kann
      setTimeout(() => comboDrop.classList.remove('open'), 150);
    });

    nameInp.addEventListener('input', () => {
      if (!tvChOverrides[src.id]) tvChOverrides[src.id] = {};
      if (!tvChOverrides[src.id][ch.id]) tvChOverrides[src.id][ch.id] = {};
      tvChOverrides[src.id][ch.id].name = nameInp.value || undefined;
      markDirty();
    });
    urlInp.addEventListener('input', () => {
      if (!tvChOverrides[src.id]) tvChOverrides[src.id] = {};
      if (!tvChOverrides[src.id][ch.id]) tvChOverrides[src.id][ch.id] = {};
      tvChOverrides[src.id][ch.id].url = urlInp.value || undefined;
      markDirty();
    });
    logoInp.addEventListener('input', () => {
      if (!tvChOverrides[src.id]) tvChOverrides[src.id] = {};
      if (!tvChOverrides[src.id][ch.id]) tvChOverrides[src.id][ch.id] = {};
      tvChOverrides[src.id][ch.id].tvgLogo = logoInp.value || undefined;
      markDirty();
    });

    tvChList.appendChild(row);
  });
}

function saveTvChEditor() {
  // Jede Quelle mit Änderungen einzeln speichern
  const promises = [];
  Object.keys(tvChOverrides).forEach(sid => {
    const source = tvSources.find(s => s.id === sid);
    if (!source) return;
    const existing = source.channelOverrides || {};
    const merged = { ...existing, ...tvChOverrides[sid] };
    // Leere Overrides entfernen
    Object.keys(merged).forEach(chId => {
      const clean = {};
      Object.keys(merged[chId]).forEach(k => {
        if (merged[chId][k] !== undefined && merged[chId][k] !== '') clean[k] = merged[chId][k];
      });
      if (Object.keys(clean).length) merged[chId] = clean;
      else delete merged[chId];
    });
    // Direkt in tvSources aktualisieren, bevor IPC zurückkommt
    source.channelOverrides = merged;
    promises.push(window.electronAPI.updateTvSource(sid, { channelOverrides: merged }));
  });

  if (!promises.length) {
    closeTvChEditor();
    return;
  }

  tvChStatus.textContent = '⏳ Speichere…';
  tvChStatus.style.color = '#94a3b8';
  Promise.all(promises).then(() => {
    tvChStatus.textContent = '✓ Gespeichert';
    tvChStatus.style.color = '#22c55e';
    tvChDirty = false;
    tvChOverrides = {};
    closeTvChEditor();
    loadTvChannels(true); // neu laden mit Overrides (jetzt in tvSources aktuell)
  });
}

function reorderChannel(draggedId, targetId) {
  const fromIdx = tvChannels.findIndex(c => c.id === draggedId);
  const toIdx = tvChannels.findIndex(c => c.id === targetId);
  if (fromIdx === -1 || toIdx === -1) return;
  const [moved] = tvChannels.splice(fromIdx, 1);
  tvChannels.splice(toIdx, 0, moved);
  renderTvChannels();

  // Persist the new sort order per source
  const sourceIds = [...new Set(tvChannels.map(c => c.sourceId))];
  sourceIds.forEach(sid => {
    const order = tvChannels.filter(c => c.sourceId === sid).map(c => c.id);
    const source = tvSources.find(s => s.id === sid);
    if (source) {
      source.sortOrder = order;
      window.electronAPI.updateTvSource(sid, { sortOrder: order });
    }
  });
}

async function selectTvChannel(ch, options = {}) {
  tvActiveChannelId = ch.id;
  overlayBar.classList.remove('always-visible');
  renderTvChannels();
  closeTvSidebar();

  // Save to history
  window.electronAPI.saveHistoryEntry({
    title: 'TV: ' + ch.name,
    serviceKey: '__tv__',
    serviceName: ch.name,
  });

  // Switch to TV mode: load player in tvView
  currentProvider = '__tv__';
  switchWebview(true);
  lastMediaTitle = 'TV: ' + ch.name;
  welcomeScreen.style.display = 'none';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  // Find current + next EPG entry (via Index)
  const now = new Date();
  const normId = id =>
    id
      .replace(/@[^.@]*/g, '')
      .toLowerCase()
      .trim();
  const chNorm = normId(ch.tvgId);
  let epgTitle = '',
    epgStart = '',
    epgEnd = '',
    epgNext = '';
  const epgList = tvEpgIndex && tvEpgIndex.get(chNorm);
  const currentIdx = epgList
    ? epgList.findIndex(e => {
        const start = parseEpgTime(e.start);
        const stop = parseEpgTime(e.stop);
        return start <= now && stop >= now;
      })
    : -1;
  if (currentIdx !== -1) {
    const cur = epgList[currentIdx];
    epgTitle = decodeEntities(cur.title);
    epgStart = formatEpgTime(cur.start);
    epgEnd = formatEpgTime(cur.stop);
    if (currentIdx + 1 < epgList.length) {
      epgNext = decodeEntities(epgList[currentIdx + 1].title);
    }
  }

  // Load tv.html with channel URL as parameter (needs file:// protocol)
  const isTvPage = tvView.getURL() && tvView.getURL().includes('tv.html');
  if (isTvPage && tvViewReady) {
    try {
      const msg = {
        type: 'switch-channel',
        url: ch.url,
        name: ch.name,
        logo: ch.logo || '',
        epg: epgTitle,
        epgStart: epgStart,
        epgEnd: epgEnd,
        epgNext: epgNext,
      };
      if (!options.suppressChannelList) {
        const channelList = buildChannelList(ch, tvChannels, tvSources);
        msg.channelList = channelList.channels;
        msg.channelIndex = channelList.currentIndex;
      }
      tvView.executeJavaScript('window.postMessage(' + JSON.stringify(msg) + ",'*')");
    } catch (e) {
      logger.warn('postMessage to tv.html failed:', e);
    }
  } else {
    const appPath = await window.electronAPI.getAppPath();
    const playerUrl =
      'file://' +
      appPath +
      '/tv.html?channel=' +
      encodeURIComponent(ch.url) +
      '&name=' +
      encodeURIComponent(ch.name) +
      '&logo=' +
      encodeURIComponent(ch.logo || '') +
      '&epg=' +
      encodeURIComponent(epgTitle) +
      '&epgStart=' +
      encodeURIComponent(epgStart) +
      '&epgEnd=' +
      encodeURIComponent(epgEnd) +
      '&epgNext=' +
      encodeURIComponent(epgNext);
    if (tvViewReady) {
      try {
        tvView.loadURL(playerUrl);
      } catch (e) {
        logger.warn('loadURL failed:', e);
      }
    } else {
      pendingNav = playerUrl;
    }
  }
}

function switchTvChannel(dir) {
  if (!tvActiveChannelId || !tvChannels.length) return;
  const sourceId = tvChannels.find(c => c.id === tvActiveChannelId)?.sourceId;
  if (!sourceId) return;
  const sourceChannels = tvChannels.filter(ch => ch.sourceId === sourceId);
  const favOrder = sourceChannels.filter(ch => isFavorite(ch, tvSources)).map(ch => ch.id);
  const order = favOrder.length ? favOrder : sourceChannels.map(ch => ch.id);
  const idx = order.indexOf(tvActiveChannelId);
  if (idx === -1) return;
  const nextId = order[(idx + dir + order.length) % order.length];
  const nextCh = tvChannels.find(c => c.id === nextId);
  if (nextCh) selectTvChannel(nextCh);
}

// ── EPG Program Overview ──

function openEpgView() {
  epgOverlay.style.display = 'flex';
  renderEpg();
}

function closeEpgView() {
  epgOverlay.style.display = 'none';
}

function renderEpg() {
  const now = Date.now();
  const totalMs = epgSlotHours * 3600000;
  const halfMs = totalMs / 2;
  const windowStart = new Date(now - halfMs);
  const windowEnd = new Date(now + halfMs);
  const totalMin = epgSlotHours * 60;

  // Favorite channels
  const favChannels = tvChannels.filter(ch => isFavorite(ch, tvSources));

  // Ruler: hour markers
  let rulerHtml = '';
  const rulerStart = new Date(windowStart);
  rulerStart.setMinutes(0, 0, 0);
  const rulerEnd = new Date(windowEnd);
  while (rulerStart < rulerEnd) {
    const left = ((rulerStart.getTime() - windowStart.getTime()) / totalMs) * 100;
    rulerHtml += `<div class="epg-time-marker" style="left:${left}%">${String(rulerStart.getHours()).padStart(2, '0')}:00</div>`;
    rulerStart.setHours(rulerStart.getHours() + 1);
  }

  let rowsHtml = '';

  for (const ch of favChannels) {
    const normId = id =>
      id
        .replace(/@[^.@]*/g, '')
        .toLowerCase()
        .trim();
    const chNorm = normId(ch.tvgId);
    const epgList = (tvEpgIndex && tvEpgIndex.get(chNorm)) || [];

    const visibleProgs = epgList.filter(e => {
      const start = parseEpgTime(e.start).getTime();
      const stop = parseEpgTime(e.stop).getTime();
      return start < windowEnd.getTime() && stop > windowStart.getTime();
    });

    let progsHtml = '';
    for (const prog of visibleProgs) {
      const startMs = parseEpgTime(prog.start).getTime();
      const stopMs = parseEpgTime(prog.stop).getTime();
      const clampedStart = Math.max(startMs, windowStart.getTime());
      const clampedStop = Math.min(stopMs, windowEnd.getTime());
      const left = ((clampedStart - windowStart.getTime()) / totalMs) * 100;
      const width = ((clampedStop - clampedStart) / totalMs) * 100;
      const isCurrent = startMs <= now && stopMs >= now;
      const isPast = stopMs <= now;

      progsHtml += `<div class="epg-program${isCurrent ? ' current' : ''}${isPast ? ' past' : ''}"
        style="left:${left}%;width:${width}%"
        data-title="${escapeHtml(prog.title)}"
        data-start="${prog.start}"
        data-stop="${prog.stop}"
        data-desc="${escapeHtml(prog.description || '')}"
        data-channel="${escapeHtml(ch.name)}"
        data-channel-id="${ch.id}"
        data-tvg-id="${ch.tvgId}">
        <div class="epg-program-title">${escapeHtml(prog.title)}</div>
        <div class="epg-program-time">${formatEpgTime(prog.start)}–${formatEpgTime(prog.stop)}</div>
      </div>`;
    }

    const nowLeft = ((now - windowStart.getTime()) / totalMs) * 100;

    rowsHtml += `<div class="epg-row" data-channel-id="${ch.id}">
      <div class="epg-channel-col">
        <img class="epg-channel-logo" src="${ch.logo || ''}" alt="" onerror="this.style.display='none'" loading="lazy">
        <span class="epg-channel-name">${escapeHtml(ch.name)}</span>
      </div>
      <div class="epg-programs-col">
        ${progsHtml}
        <div class="epg-now-line" style="left:${nowLeft}%"></div>
      </div>
    </div>`;
  }

  // Range label
  const fmtOpt = { hour: '2-digit', minute: '2-digit' };
  epgRangeLabel.textContent = `${windowStart.toLocaleTimeString('de-DE', fmtOpt)} – ${windowEnd.toLocaleTimeString('de-DE', fmtOpt)} (${epgSlotHours}h)`;

  if (!favChannels.length) {
    epgBody.innerHTML =
      '<div class="epg-loading">Keine Favoriten vorhanden.<br>Markiere Sender in der TV-Seitenleiste als Favorit.</div>';
    return;
  }

  epgBody.innerHTML = `<div class="epg-grid">
    <div class="epg-row epg-ruler">
      <div class="epg-channel-col"><span class="epg-channel-name"></span></div>
      <div class="epg-programs-col">${rulerHtml}</div>
    </div>
    ${rowsHtml}
  </div>`;

  // Click handlers
  epgBody.querySelectorAll('.epg-program').forEach(el => {
    el.addEventListener('click', () => showEpgDetail(el.dataset));
  });
}

function showEpgDetail(data) {
  epgDetailTitle.textContent = data.title;
  const startStr = formatEpgTime(data.start);
  const stopStr = formatEpgTime(data.stop);
  epgDetailMeta.textContent = `${startStr} – ${stopStr} · ${data.channel}`;
  epgDetailDesc.textContent = data.desc || 'Keine Beschreibung verfügbar.';

  epgDetailActions.innerHTML = '';

  // Watch button
  const watchBtn = document.createElement('button');
  watchBtn.className = 'epg-action-btn epg-watch-btn';
  watchBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Sender öffnen';
  watchBtn.addEventListener('click', () => {
    closeEpgDetail();
    closeEpgView();
    const ch = tvChannels.find(c => c.id === data.channelId);
    if (ch) {
      selectTvChannel(ch, { suppressChannelList: true });
      openTvSidebar();
    }
  });
  epgDetailActions.appendChild(watchBtn);

  // Mediathek button
  const mediathek = getMediathekForChannel(data.tvgId || data.channel);
  if (mediathek) {
    const svc = services.find(s => s.id === mediathek.serviceId);
    const medBtn = document.createElement('button');
    medBtn.className = 'epg-action-btn epg-mediathek-btn';
    medBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> In ${svc ? svc.name : 'Mediathek'} ansehen`;
    medBtn.addEventListener('click', () => {
      closeEpgDetail();
      closeEpgView();
      if (svc) {
        navigateTo({ ...svc, url: mediathek.searchUrl + encodeURIComponent(data.title) });
      }
    });
    epgDetailActions.appendChild(medBtn);
  }

  epgDetailBackdrop.style.display = 'flex';
}

function closeEpgDetail() {
  epgDetailBackdrop.style.display = 'none';
}

// ── TV Keyboard shortcut ──

// ── Shortcuts overlay ──
function toggleShortcuts() {
  shortcutsOverlay.classList.toggle('open');
}

// History overlay
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
      <div class="history-entry-meta">${escapeHtml(svcName)} · ${formatTimestamp(e.timestamp)}</div>
    `;
    row.appendChild(body);

    row.addEventListener('click', () => {
      closeHistory();
      if (svc) {
        navigateTo(svc);
      } else if (e.serviceKey === '__tv__') {
        openTvSidebar();
      }
    });

    historyList.appendChild(row);
  }
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

// TV channel navigation via webview ipc-message (from tv.html → preload-content bridge)
webview.addEventListener('ipc-message', e => {
  if (e.channel === 'tv-channel' && e.args[0] && e.args[0].source === 'tv-player') {
    if (e.args[0].action === 'channel-next') switchTvChannel(1);
    else if (e.args[0].action === 'channel-prev') switchTvChannel(-1);
    else if (e.args[0].action === 'request-epg') sendEpgUpdate();
  }
});

function sendEpgUpdate() {
  if (!tvActiveChannelId) return;
  const ch = tvChannels.find(c => c.id === tvActiveChannelId);
  if (!ch) return;
  const now = new Date();
  const normId = id =>
    id
      .replace(/@[^.@]*/g, '')
      .toLowerCase()
      .trim();
  const chNorm = normId(ch.tvgId);
  let epgTitle = '',
    epgStart = '',
    epgEnd = '',
    epgNext = '';
  const epgList = tvEpgIndex && tvEpgIndex.get(chNorm);
  const currentIdx = epgList
    ? epgList.findIndex(e => {
        const s = parseEpgTime(e.start);
        const t = parseEpgTime(e.stop);
        return s <= now && t >= now;
      })
    : -1;
  if (currentIdx !== -1) {
    const cur = epgList[currentIdx];
    epgTitle = decodeEntities(cur.title);
    epgStart = formatEpgTime(cur.start);
    epgEnd = formatEpgTime(cur.stop);
    if (currentIdx + 1 < epgList.length) {
      epgNext = decodeEntities(epgList[currentIdx + 1].title);
    }
  }
  const data = {
    type: 'epg-update',
    epg: epgTitle,
    epgStart: epgStart,
    epgEnd: epgEnd,
    epgNext: epgNext,
  };
  try {
    webview.executeJavaScript('window.postMessage(' + JSON.stringify(data) + ",'*')");
  } catch (err) {
    logger.warn('sendEpgUpdate failed:', err);
  }
}

// Webview events
webview.addEventListener('did-attach', () => {
  webviewReady = true;

  if (webview.session) {
    const filter = { urls: ['*://*/*'] };
    webview.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      details.requestHeaders['User-Agent'] = chromeUA;
      callback({ requestHeaders: details.requestHeaders });
    });
  }

  if (pendingNav) {
    webview.loadURL(pendingNav);
    pendingNav = null;
  }
});

webview.addEventListener('destroyed', () => {
  webview.session?.webRequest.onBeforeSendHeaders(null);
});

webview.addEventListener('did-finish-load', () => {
  hideError();
  webview
    .insertCSS(
      `
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
    ::-webkit-scrollbar-corner { background: transparent; }
    * { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.15) transparent; }
  `,
    )
    .catch(() => {});
  scheduleMediaCheck();
  // Send channel list when tv.html finishes loading
  if (tvActiveChannelId && webview.getURL().includes('tv.html')) {
    const ch = tvChannels.find(c => c.id === tvActiveChannelId);
    if (ch) {
      const cl = buildChannelList(ch, tvChannels, tvSources);
      webview
        .executeJavaScript(
          'window.postMessage(' +
            JSON.stringify({
              type: 'channel-list',
              channels: cl.channels,
              currentIndex: cl.currentIndex,
            }) +
            ",'*')",
        )
        .catch(() => {});
    }
  }
});

webview.addEventListener('did-navigate', () => {
  const url = webview.getURL();
  for (const svc of services) {
    if (url.includes(svc.id) || url.startsWith(svc.url)) {
      currentProvider = svc.id;
      break;
    }
  }
});

webview.addEventListener('permissionrequest', e => {
  if (e.permission === 'media' || e.permission === 'mediaKeySystemAccess') {
    e.request.allow();
  } else {
    e.request.deny();
  }
});

// ── Webview Error Recovery (contentView) ──

webview.addEventListener('did-fail-load', e => {
  // Ignore cancelled navigations (e.g. from about:blank)
  if (e.errorCode === -3) return;
  logger.warn('contentView did-fail-load:', e.errorCode, e.errorDescription, e.validatedURL);
  showError('Seite konnte nicht geladen werden.\n' + e.errorDescription, e.validatedURL);
});

webview.addEventListener('crashed', () => {
  logger.error('contentView crashed – versuche Wiederherstellung');
  showError('Die Seite ist abgestürzt. Klicke auf "Neu laden" um fortzufahren.');
});

webview.addEventListener('unresponsive', () => {
  logger.warn('contentView unresponsive');
});

// ── tvView Event Listeners ──

tvView.addEventListener('did-attach', () => {
  tvViewReady = true;

  if (tvView.session) {
    const filter = { urls: ['*://*/*'] };
    tvView.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      details.requestHeaders['User-Agent'] = chromeUA;
      callback({ requestHeaders: details.requestHeaders });
    });
  }

  if (pendingNav) {
    tvView.loadURL(pendingNav);
    pendingNav = null;
  }
});

tvView.addEventListener('destroyed', () => {
  tvView.session?.webRequest.onBeforeSendHeaders(null);
});

tvView.addEventListener('did-finish-load', () => {
  hideError();
  tvView
    .insertCSS(
      `
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
    ::-webkit-scrollbar-corner { background: transparent; }
    * { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.15) transparent; }
  `,
    )
    .catch(() => {});
  // Send channel list when tv.html finishes loading
  if (tvActiveChannelId && tvView.getURL().includes('tv.html')) {
    const ch = tvChannels.find(c => c.id === tvActiveChannelId);
    if (ch) {
      const cl = buildChannelList(ch, tvChannels, tvSources);
      tvView
        .executeJavaScript(
          'window.postMessage(' +
            JSON.stringify({
              type: 'channel-list',
              channels: cl.channels,
              currentIndex: cl.currentIndex,
            }) +
            ",'*')",
        )
        .catch(() => {});
    }
  }
});

tvView.addEventListener('permissionrequest', e => {
  if (e.permission === 'media' || e.permission === 'mediaKeySystemAccess') {
    e.request.allow();
  } else {
    e.request.deny();
  }
});

// TV channel navigation from tv.html in tvView
tvView.addEventListener('ipc-message', e => {
  if (e.channel === 'tv-channel' && e.args[0] && e.args[0].source === 'tv-player') {
    if (e.args[0].action === 'channel-next') switchTvChannel(1);
    else if (e.args[0].action === 'channel-prev') switchTvChannel(-1);
    else if (e.args[0].action === 'request-epg') sendEpgUpdate();
  }
});

// ── tvView Error Recovery ──

tvView.addEventListener('did-fail-load', e => {
  if (e.errorCode === -3) return;
  logger.warn('tvView did-fail-load:', e.errorCode, e.errorDescription, e.validatedURL);
  showError('TV-Seite konnte nicht geladen werden.\n' + e.errorDescription, e.validatedURL);
});

tvView.addEventListener('crashed', () => {
  logger.error('tvView crashed – versuche Wiederherstellung');
  showError('TV-Player ist abgestürzt. Klicke auf "Neu laden" um fortzufahren.');
});

tvView.addEventListener('unresponsive', () => {
  logger.warn('tvView unresponsive');
});

// Media Session title → save to history (poll via executeJavaScript)
let lastMediaTitle = '';
function pollMediaTitle() {
  const svc = getCurrentSvc();
  if (!svc) return;
  webview
    .executeJavaScript('navigator.mediaSession?.metadata?.title || ""')
    .then(title => {
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

  // In TV mode, extract the actual stream URL for PiP
  if (currentProvider === '__tv__') {
    const params = new URLSearchParams(url.split('?')[1] || '');
    const streamUrl = params.get('channel');
    if (streamUrl) {
      window.electronAPI.togglePip(streamUrl);
      return;
    }
  }
  window.electronAPI.togglePip(url);
});

window.electronAPI.onPipState(state => {
  pipActive = state;
  pipBtn.classList.toggle('active', state);
});

historyBtn.addEventListener('click', toggleHistory);
historyClose.addEventListener('click', closeHistory);
historyOverlay.addEventListener('click', e => {
  if (e.target === historyOverlay) closeHistory();
});
historyClear.addEventListener('click', () => {
  window.electronAPI.clearHistory().then(renderHistory);
});

// TV event listeners
tvSidebarManage.addEventListener('click', openTvModal);
tvSidebarEpgRefresh.addEventListener('click', refreshEpg);
tvModalClose.addEventListener('click', closeTvModal);
tvModalOverlay.addEventListener('click', e => {
  if (e.target === tvModalOverlay) closeTvModal();
});
tvModalSave.addEventListener('click', saveTvSource);

tvFileBtn.addEventListener('click', () => {
  window.electronAPI.pickM3uFile().then(filePath => {
    if (filePath) tvInputUrl.value = filePath;
  });
});

tvInputName.addEventListener('keydown', e => {
  if (e.key === 'Enter') tvInputUrl.focus();
});
tvInputUrl.addEventListener('keydown', e => {
  if (e.key === 'Enter') tvInputEpgUrl.focus();
});
tvInputEpgUrl.addEventListener('keydown', e => {
  if (e.key === 'Enter') saveTvSource();
});

tvSidebarTrigger.addEventListener('mouseenter', () => {
  if (!tvSidebarOpen) openTvSidebar();
});

let tvSidebarTimer = null;
function scheduleSidebarClose() {
  clearTimeout(tvSidebarTimer);
  tvSidebarTimer = setTimeout(() => {
    if (tvSidebarOpen) closeTvSidebar();
  }, 400);
}
tvSidebar.addEventListener('mouseenter', () => clearTimeout(tvSidebarTimer));
tvSidebar.addEventListener('mouseleave', scheduleSidebarClose);
tvSidebarTrigger.addEventListener('mouseleave', e => {
  if (!e.relatedTarget || !tvSidebar.contains(e.relatedTarget)) {
    scheduleSidebarClose();
  }
});

tvSearchInput.addEventListener('input', () => {
  tvSearchFilter = tvSearchInput.value;
  renderTvChannels();
});

tvSearchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    tvSearchInput.value = '';
    tvSearchFilter = '';
    renderTvChannels();
    tvSearchInput.blur();
  }
});

// TV Channel Editor
tvSidebarEdit.addEventListener('click', openTvChEditor);
tvChModalClose.addEventListener('click', closeTvChEditor);
tvChModalOverlay.addEventListener('click', e => {
  if (e.target === tvChModalOverlay) closeTvChEditor();
});
tvChModalSave.addEventListener('click', saveTvChEditor);
tvChSearch.addEventListener('input', renderTvChEditor);
tvChSearch.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    tvChSearch.value = '';
    renderTvChEditor();
    tvChSearch.blur();
  }
});

// Close sidebar when clicking outside (not on start page)
document.addEventListener('click', e => {
  if (
    tvSidebarOpen &&
    currentProvider !== '' &&
    !tvSidebar.contains(e.target) &&
    !tvBtn.contains(e.target) &&
    !tvSidebarTrigger.contains(e.target)
  ) {
    closeTvSidebar();
  }
});

// ── EPG Event Wiring ──
tvSidebarEpgBtn.addEventListener('click', openEpgView);
epgCloseBtn.addEventListener('click', closeEpgView);
epgRefreshBtn.addEventListener('click', () => {
  refreshEpg();
  renderEpg();
});
epgDetailClose.addEventListener('click', closeEpgDetail);
epgDetailBackdrop.addEventListener('click', e => {
  if (e.target === epgDetailBackdrop) closeEpgDetail();
});

// EPG time slot buttons
document.querySelectorAll('.epg-slot-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.epg-slot-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    epgSlotHours = parseInt(btn.dataset.hours, 10);
    renderEpg();
  });
});

// Keyboard shortcut handler (shared for document + webview forwarding)
function handleKeyShortcut(key, ctrlKey, shiftKey, metaKey) {
  if (key === 'Escape') {
    if (shortcutsOverlay.classList.contains('open')) {
      shortcutsOverlay.classList.remove('open');
      return true;
    }
    if (tvModalOverlay.classList.contains('open')) {
      closeTvModal();
      return true;
    }
    if (settingsOverlay.classList.contains('open')) {
      closeSettings();
      return true;
    }
    if (tvSidebarOpen) {
      closeTvSidebar();
      return true;
    }
    if (epgDetailBackdrop.style.display !== 'none') {
      closeEpgDetail();
      return true;
    }
    if (epgOverlay.style.display !== 'none') {
      closeEpgView();
      return true;
    }
    if (historyOverlay.classList.contains('open')) {
      closeHistory();
      return true;
    }
    // Don't consume Escape if nothing is open (let webview handle it)
    return false;
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

  if (ctrlKey && (key === 't' || key === 'T')) {
    toggleTvSidebar();
    return true;
  }

  if ((key === 'ArrowUp' || key === 'ArrowDown') && currentProvider === '__tv__') {
    switchTvChannel(key === 'ArrowUp' ? -1 : 1);
    return true;
  }

  return false;
}

document.addEventListener('keydown', e => {
  // Skip when typing in inputs (except Escape which is handled by webview forward)
  if (e.target.tagName === 'INPUT') {
    if (e.key === 'Escape') {
      if (shortcutsOverlay.classList.contains('open')) {
        shortcutsOverlay.classList.remove('open');
        e.preventDefault();
      } else if (settingsOverlay.classList.contains('open')) {
        closeSettings();
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
const cleanupShortcuts = window.electronAPI.onWebviewKeydown(data => {
  handleKeyShortcut(data.key, data.ctrlKey, data.shiftKey, data.metaKey);
});

// Global media keys → webview Media Session
window.electronAPI.onMediaKey(action => {
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
window.electronAPI.getAppVersion().then(v => {
  document.getElementById('versionTag').textContent = 'v' + v;
});

// ── Autoupdate ──

const updateBtn = document.getElementById('updateBtn');
let updateAvailableVersion = null;
let updateChecking = false;

function setUpdateState(state) {
  updateBtn.classList.remove('update-available', 'uptodate');
  if (state === 'checking') {
    updateBtn.title = 'Suche…';
    updateBtn.disabled = true;
  } else if (state === 'uptodate') {
    updateBtn.title = 'Update auf dem neuesten Stand';
    updateBtn.disabled = false;
    updateBtn.classList.add('uptodate');
  } else if (state === 'available') {
    updateBtn.title = `Update v${updateAvailableVersion} verfügbar – Klicken zum Installieren`;
    updateBtn.disabled = false;
    updateBtn.classList.add('update-available');
  } else if (state === 'progress') {
    updateBtn.title = `Update wird geladen… ${Math.round(updateBtn._percent || 0)}%`;
    updateBtn.disabled = true;
  } else if (state === 'downloaded') {
    updateBtn.title = 'Update bereit – Neustart…';
    updateBtn.disabled = true;
  }
}

async function checkForUpdates() {
  if (updateChecking) return;
  updateChecking = true;
  setUpdateState('checking');
  const result = await window.electronAPI.checkForUpdate();
  updateChecking = false;
  if (result.hasUpdate && result.latestVersion) {
    updateAvailableVersion = result.latestVersion;
    setUpdateState('available');
  } else {
    updateAvailableVersion = null;
    setUpdateState('uptodate');
  }
}

// ── Update Overlay ──
const updateOverlay = document.getElementById('updateOverlay');
const updateTitle = document.getElementById('updateTitle');
const updateStep = document.getElementById('updateStep');
const updateProgressFill = document.getElementById('updateProgressFill');

function showUpdateOverlay(title) {
  updateTitle.textContent = title || 'Update wird installiert…';
  updateStep.textContent = 'Vorbereiten…';
  updateProgressFill.style.width = '0%';
  updateOverlay.classList.add('open');
}

function hideUpdateOverlay() {
  updateOverlay.classList.remove('open');
}

const cleanupUpdateStatus = window.electronAPI.onUpdateStatus(status => {
  if (status.type === 'available') {
    updateAvailableVersion = status.version;
    setUpdateState('available');
  } else if (status.type === 'not-available') {
    setUpdateState('uptodate');
  } else if (status.type === 'error') {
    hideUpdateOverlay();
    setUpdateState('uptodate');
  } else if (status.type === 'progress') {
    updateBtn._percent = status.percent;
    if (status.step) {
      updateStep.textContent = status.step;
    } else if (status.percent !== undefined) {
      updateStep.textContent = 'Lade Update herunter… ' + Math.round(status.percent) + '%';
    }
    if (status.percent !== undefined) {
      updateProgressFill.style.width = Math.min(status.percent, 100) + '%';
    }
    setUpdateState('progress');
  } else if (status.type === 'downloaded') {
    updateStep.textContent = 'Download abgeschlossen – Neustart…';
    updateProgressFill.style.width = '100%';
    setUpdateState('downloaded');
  }
});

updateBtn.addEventListener('click', async () => {
  if (updateChecking || updateBtn.disabled) return;
  if (updateAvailableVersion) {
    if (confirm(`Update v${updateAvailableVersion} installieren?\nDie App wird nach der Installation neugestartet.`)) {
      updateBtn.disabled = true;
      updateBtn.title = 'Installiere…';
      showUpdateOverlay(`Update v${updateAvailableVersion} wird installiert…`);
      updateStep.textContent = 'Starte Installation…';
      const result = await window.electronAPI.applyUpdate(updateAvailableVersion);
      if (!result.success) {
        hideUpdateOverlay();
        updateBtn.disabled = false;
        updateBtn.title = `Fehlgeschlagen: ${result.error}`;
        setTimeout(() => setUpdateState('available'), 5000);
      }
    }
  } else {
    checkForUpdates();
  }
});

// Prüfe beim Start (nach kurzer Verzögerung)
setTimeout(checkForUpdates, 4000);

// ── Backup / Restore ──

const settingsBtn = document.getElementById('settingsBtn');
const settingsOverlay = document.getElementById('settingsOverlay');
const settingsClose = document.getElementById('settingsClose');
const settingsStatus = document.getElementById('settingsStatus');
const backupBtn = document.getElementById('backupBtn');
const restoreBtn = document.getElementById('restoreBtn');

function openSettings() {
  settingsStatus.textContent = '';
  renderSettingsServices();
  settingsAddForm.style.display = 'none';
  settingsOverlay.classList.add('open');
}

function closeSettings() {
  settingsOverlay.classList.remove('open');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', e => {
  if (e.target === settingsOverlay) closeSettings();
});

backupBtn.addEventListener('click', async () => {
  backupBtn.disabled = true;
  settingsStatus.textContent = 'Speichere…';
  const result = await window.electronAPI.backupSettings();
  if (result.success) {
    settingsStatus.textContent = '✓ Backup gespeichert';
  } else {
    settingsStatus.textContent = 'Abgebrochen';
  }
  setTimeout(() => {
    backupBtn.disabled = false;
  }, 2000);
});

restoreBtn.addEventListener('click', async () => {
  if (!confirm('Backup einspielen?\nAktuelle Dienste, TV-Quellen und Verlauf werden überschrieben.')) return;
  restoreBtn.disabled = true;
  settingsStatus.textContent = 'Stelle wieder her…';
  const result = await window.electronAPI.restoreSettings();
  if (result.success) {
    settingsStatus.textContent = '✓ Backup eingespielt';
  } else if (result.error) {
    settingsStatus.textContent = '✗ Fehler: ' + result.error;
  } else {
    settingsStatus.textContent = 'Abgebrochen';
  }
  setTimeout(() => {
    restoreBtn.disabled = false;
  }, 3000);
});

// Services laden
window.electronAPI.getServices().then(svcs => {
  services = svcs;
  renderNav();
  tvBtn = document.getElementById('tvBtn');
});

window.electronAPI.onServicesChanged(svcs => {
  services = svcs;
  renderNav();
  tvBtn = document.getElementById('tvBtn');
  renderSettingsServices();
  if (currentProvider === '__tv__') {
    // Stay in TV mode
    return;
  }
  if (currentProvider && services.find(s => s.id === currentProvider)) {
    const btn = nav.querySelector(`.nav-item[data-provider="${currentProvider}"]`);
    if (btn) btn.classList.add('active');
  } else {
    currentProvider = '';
    overlayLocation.textContent = 'Startseite';
  }
});

// Startseite-Klick
overlayLocation.addEventListener('click', goToStartPage);

// TV Sources laden
window.electronAPI.getTvSources().then(sources => {
  tvSources = sources;
  tvSelectedSourceIds = sources.map(s => s.id);
  loadEpgData();
  if (tvSources.length) openTvSidebar();
});

window.electronAPI.onTvSourcesChanged(sources => {
  // Nur bei strukturellen Änderungen (neue/entfernte Quelle, URL-, EPG- oder Override-Änderung) neu laden,
  // nicht bei reinen sortOrder/favorites-Änderungen (Drag&Drop)
  const structuralChange =
    sources.length !== tvSources.length ||
    sources.some(s => {
      const old = tvSources.find(t => t.id === s.id);
      return (
        !old ||
        old.url !== s.url ||
        old.epgUrl !== s.epgUrl ||
        JSON.stringify(old.channelOverrides) !== JSON.stringify(s.channelOverrides)
      );
    });
  tvSources = sources;
  tvSelectedSourceIds = tvSelectedSourceIds.filter(id => sources.some(s => s.id === id));
  if (!tvSelectedSourceIds.length && sources.length) tvSelectedSourceIds = sources.map(s => s.id);

  renderTvSourceList();
  if (tvSidebarOpen) {
    renderSourcePills();
    if (structuralChange) {
      loadTvChannels(true);
      loadEpgData();
    } else renderTvChannels();
  }
});
