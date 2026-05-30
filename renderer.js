// v0.3.7. – Kanalwechsel per postMessage (kein Vollbild-Ende) + Reihenfolge = Sidebar
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

const nav = document.getElementById('overlayNav');
let tvBtn = null;
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

// TV DOM references
const tvSidebar = document.getElementById('tvSidebar');
const tvSidebarTrigger = document.getElementById('tvSidebarTrigger');
const tvSidebarClose = document.getElementById('tvSidebarClose');
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
const tvChStatus = document.getElementById('tvChStatus');

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

  const groups = [
    { key: 'livetv',    label: 'LiveTV' },
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
      btn.addEventListener('mousedown', (e) => {
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
  // If in TV mode, navigate to first/last service
  if (currentProvider === '__tv__') {
    navigateTo(dir > 0 ? services[0] : services[services.length - 1]);
    return;
  }
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
  tvBtn.classList.add('active');

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
  tvBtn.classList.remove('active');
}

function loadTvChannels(forceReload) {
  // Cache: nicht erneut laden wenn Daten bereits vorhanden
  if (!forceReload && tvChannels.length > 0 && tvEpgData.length > 0) {
    renderTvChannels();
    return;
  }
  tvSidebarChannels.innerHTML = '<div class="tv-sidebar-empty">Lade Sender...</div>';
  tvChannels = [];
  tvEpgData = [];
  tvEpgIndex = null;
  let tvEpgUrls = [];

  if (!tvSources.length) {
    tvSidebarChannels.innerHTML = '<div class="tv-sidebar-empty">Keine Sender geladen.<br>Füge eine TV-Quelle hinzu.</div>';
    tvSidebarStatus.textContent = 'Keine Quellen';
    return;
  }

  tvSidebarStatus.textContent = tvSources.map(s => s.name).join(', ');
  let parsePromises = [];
  let sourceChannelMap = {}; // sourceId → channels[]

  tvSources.forEach(source => {
    const p = window.electronAPI.fetchAndParseM3U(source.url)
      .then(result => {
        const tagged = result.channels.map(ch => ({ ...ch, sourceId: source.id }));
        sourceChannelMap[source.id] = tagged;
        tvChannels = tvChannels.concat(tagged);
        const srcEpgUrl = source.epgUrl || (result.epgUrls && result.epgUrls[0]);
        if (srcEpgUrl && !tvEpgUrls.includes(srcEpgUrl)) {
          tvEpgUrls.push(srcEpgUrl);
        }
      })
      .catch(err => {
        console.warn('Fehler beim Laden von', source.name, err.message);
        sourceChannelMap[source.id] = [];
      });
    parsePromises.push(p);
  });

  Promise.all(parsePromises).then(() => {
    // Apply channel overrides (user-edited name/url/tvgId)
    tvChannels = [];
    tvSources.forEach(source => {
      let srcChannels = sourceChannelMap[source.id] || [];
      const srcOverrides = source.channelOverrides || {};
      srcChannels = srcChannels.map(ch => {
        const ov = srcOverrides[ch.id];
        return ov ? { ...ch, ...ov } : ch;
      });
      if (source.sortOrder && source.sortOrder.length) {
        const ordered = [];
        const unordered = [];
        source.sortOrder.forEach(id => {
          const idx = srcChannels.findIndex(c => c.id === id);
          if (idx !== -1) ordered.push(srcChannels.splice(idx, 1)[0]);
        });
        srcChannels = ordered.concat(srcChannels);
      }
      tvChannels = tvChannels.concat(srcChannels);
    });

    renderTvChannels();
    // Fetch EPG from all discovered URLs
    if (tvEpgUrls.length) {
      tvSidebarStatus.innerHTML = tvSources.map(s => s.name).join(', ')
        + ' <span class="tv-epg-loading">EPG lädt…</span>';
      Promise.all(tvEpgUrls.map(url =>
        window.electronAPI.fetchEPG(url).catch(() => [])
      )).then(results => {
        tvEpgData = results.flat();
        buildEpgIndex();
        tvSidebarStatus.textContent = tvSources.map(s => s.name).join(', ');
        if (tvEpgData.length) {
          tvSidebarStatus.textContent += ' | EPG: ' + tvEpgIndex.size + ' Kanäle';
        }
        renderTvChannels();
      }).catch(() => {
        tvSidebarStatus.textContent = tvSources.map(s => s.name).join(', ') + ' | EPG-Fehler';
      });
    } else {
      const hasEpgConfig = tvSources.some(s => s.epgUrl);
      if (!hasEpgConfig) {
        tvSidebarStatus.textContent = tvSources.map(s => s.name).join(', ') + ' | Keine EPG-URL';
      } else {
        tvSidebarStatus.textContent = tvSources.map(s => s.name).join(', ') + ' | ⏳ EPG lädt…';
        // EPG-URLs aus Quellen direkt verwenden (Fallback falls M3U-Kopfzeilen fehlen)
        const fallbackUrls = [...new Set(tvSources.map(s => s.epgUrl).filter(Boolean))];
        if (fallbackUrls.length) {
          Promise.all(fallbackUrls.map(url =>
            window.electronAPI.fetchEPG(url).catch(() => [])
          )).then(results => {
            tvEpgData = results.flat();
            buildEpgIndex();
            tvSidebarStatus.textContent = tvSources.map(s => s.name).join(', ');
            if (tvEpgData.length) {
              tvSidebarStatus.textContent += ' | EPG: ' + tvEpgIndex.size + ' Kanäle';
            }
            renderTvChannels();
          });
        }
      }
    }
    scheduleEpgRefresh(tvEpgUrls);
  });
}

let epgRefreshTimer = null;

function scheduleEpgRefresh(urls) {
  if (epgRefreshTimer) clearInterval(epgRefreshTimer);
  if (!urls.length) return;
  epgRefreshTimer = setInterval(() => {
    Promise.all(urls.map(url =>
      window.electronAPI.fetchEPG(url).catch(() => [])
    )).then(results => {
      tvEpgData = results.flat();
      buildEpgIndex();
      if (tvSidebarOpen) renderTvChannels();
    });
  }, 30 * 60 * 1000);
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

function isFavorite(ch) {
  const source = tvSources.find(s => s.id === ch.sourceId);
  return source && source.favorites && source.favorites.includes(ch.id);
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

  Promise.all(epgUrls.map(url =>
    window.electronAPI.fetchEPG(url).catch(() => [])
  )).then(results => {
    tvEpgData = results.flat();
    buildEpgIndex();
    renderTvChannels();
  }).finally(() => {
    tvEpgRefreshing = false;
    tvSidebarEpgRefresh.classList.remove('refreshing');
  });
}

function renderTvChannelItem(ch, showFav) {
  const item = document.createElement('div');
  item.className = 'tv-channel-item' + (ch.id === tvActiveChannelId ? ' active' : '');
  item.dataset.channelId = ch.id;

  const now = new Date();
  const normId = (id) => id.replace(/@[^.@]*/g, '').toLowerCase().trim();
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
  const fav = isFavorite(ch);
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

  item.addEventListener('click', (e) => {
    if (e.target.closest('.tv-channel-drag')) return;
    if (e.target.closest('.tv-channel-fav')) {
      e.stopPropagation();
      toggleFavorite(ch);
      return;
    }
    selectTvChannel(ch);
  });

  const dragHandle = item.querySelector('.tv-channel-drag');
  dragHandle.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', ch.id);
    item.classList.add('dragging');
  });
  dragHandle.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    document.querySelectorAll('.tv-channel-item.drag-over').forEach(el => el.classList.remove('drag-over'));
  });
  item.addEventListener('dragover', (e) => {
    e.preventDefault();
    item.classList.add('drag-over');
  });
  item.addEventListener('dragleave', () => {
    item.classList.remove('drag-over');
  });
  item.addEventListener('drop', (e) => {
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

  const filter = tvSearchFilter.toLowerCase().trim();

  // Filter channels by selected sources and search
  let filtered = tvChannels.filter(ch => tvSelectedSourceIds.includes(ch.sourceId));
  if (filter) {
    filtered = filtered.filter(ch =>
      ch.name.toLowerCase().includes(filter) ||
      ch.group.toLowerCase().includes(filter)
    );
  }

  if (!filtered.length) {
    tvSidebarChannels.innerHTML = '<div class="tv-sidebar-empty">Keine Sender gefunden.</div>';
    return;
  }

  // Separate favorites from the rest
  const favoriteChannels = filtered.filter(ch => isFavorite(ch));
  const regularChannels = filtered.filter(ch => !isFavorite(ch));

  // Group regular channels
  const groups = {};
  regularChannels.forEach(ch => {
    if (!groups[ch.group]) groups[ch.group] = [];
    groups[ch.group].push(ch);
  });

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
    const totalInGroup = tvChannels.filter(c => c.group === groupName && tvSelectedSourceIds.includes(c.sourceId)).length;
    const showCount = groups[groupName].length;
    const countStr = showCount < totalInGroup ? `${showCount}/${totalInGroup}` : String(totalInGroup);
    header.innerHTML = `<span class="tv-channel-group-arrow">▼</span> ${escapeHtml(groupName)} (${countStr})`;
    header.addEventListener('click', () => {
      header.classList.toggle('collapsed');
      tvCollapsedGroups[groupName] = header.classList.contains('collapsed');
      try { localStorage.setItem('tv-collapsed-groups', JSON.stringify(tvCollapsedGroups)); } catch {}
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

function getEpgChannelList() {
  if (!tvEpgIndex) return [];
  const list = [];
  tvEpgIndex.forEach((entries, normId) => {
    const entry = entries[0];
    list.push({ normId, channelId: entry.channelId, sampleTitle: entry.title });
  });
  return list.sort((a, b) => a.normId.localeCompare(b.normId));
}

function openTvChEditor() {
  tvChOverrides = {};
  tvChDirty = false;
  tvChStatus.textContent = '';
  tvEpgChannelList = getEpgChannelList();
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
    items = items.filter(({ ch }) =>
      ch.name.toLowerCase().includes(filter) ||
      ch.tvgId.toLowerCase().includes(filter) ||
      ch.url.toLowerCase().includes(filter)
    );
  }
  tvChList.innerHTML = '';
  items.forEach(({ ch, src }) => {
    const ov = (tvChOverrides[src.id] && tvChOverrides[src.id][ch.id]) || {};
    const effName = ov.name != null ? ov.name : ch.name;
    const effUrl = ov.url != null ? ov.url : ch.url;
    const effTvgId = ov.tvgId != null ? ov.tvgId : ch.tvgId;
    const effLogo = ov.tvgLogo != null ? ov.tvgLogo : (ch.logo || '');

    // EPG-Status
    const normId = (id) => id.replace(/@[^.@]*/g, '').toLowerCase().trim();
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
        item.addEventListener('mousedown', (e) => {
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
    loadTvChannels(true); // neu laden mit Overrides
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

async function selectTvChannel(ch) {
  tvActiveChannelId = ch.id;
  renderTvChannels();
  closeTvSidebar();

  // Save to history
  window.electronAPI.saveHistoryEntry({
    title: 'TV: ' + ch.name,
    serviceKey: '__tv__',
    serviceName: ch.name,
  });

  // Switch to TV mode: load player in webview
  currentProvider = '__tv__';
  lastMediaTitle = 'TV: ' + ch.name;
  welcomeScreen.style.display = 'none';
  overlayLocation.textContent = 'TV: ' + ch.name;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  // Find current + next EPG entry (via Index)
  const now = new Date();
  const normId = (id) => id.replace(/@[^.@]*/g, '').toLowerCase().trim();
  const chNorm = normId(ch.tvgId);
  let epgTitle = '', epgStart = '', epgEnd = '', epgNext = '';
  const epgList = tvEpgIndex && tvEpgIndex.get(chNorm);
  const currentIdx = epgList ? epgList.findIndex(e => {
    const start = parseEpgTime(e.start);
    const stop = parseEpgTime(e.stop);
    return start <= now && stop >= now;
  }) : -1;
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
  const isTvPage = webview.getURL() && webview.getURL().includes('tv.html');
  if (isTvPage && webviewReady) {
    try {
      webview.executeJavaScript("window.postMessage(" + JSON.stringify({
        type: 'switch-channel',
        url: ch.url,
        name: ch.name,
        logo: ch.logo || '',
        epg: epgTitle,
        epgStart: epgStart,
        epgEnd: epgEnd,
        epgNext: epgNext,
      }) + ",'*')");
    } catch (e) { console.warn('postMessage to tv.html failed:', e); }
  } else {
    const appPath = await window.electronAPI.getAppPath();
    const playerUrl = 'file://' + appPath + '/tv.html?channel=' + encodeURIComponent(ch.url)
      + '&name=' + encodeURIComponent(ch.name)
      + '&logo=' + encodeURIComponent(ch.logo || '')
      + '&epg=' + encodeURIComponent(epgTitle)
      + '&epgStart=' + encodeURIComponent(epgStart)
      + '&epgEnd=' + encodeURIComponent(epgEnd)
      + '&epgNext=' + encodeURIComponent(epgNext);
    if (webviewReady) {
      try { webview.loadURL(playerUrl); } catch (e) { console.warn('loadURL failed:', e); }
    } else {
      pendingNav = playerUrl;
    }
  }
}

function switchTvChannel(dir) {
  if (!tvActiveChannelId || !tvChannels.length) return;
  const sourceId = tvChannels.find(c => c.id === tvActiveChannelId)?.sourceId;
  if (!sourceId) return;
  const favOrder = tvChannels.filter(ch => ch.sourceId === sourceId && isFavorite(ch)).map(ch => ch.id);
  if (!favOrder.length) return;
  const idx = favOrder.indexOf(tvActiveChannelId);
  if (idx === -1) return;
  const nextId = favOrder[(idx + dir + favOrder.length) % favOrder.length];
  const nextCh = tvChannels.find(c => c.id === nextId);
  if (nextCh) selectTvChannel(nextCh);
}

function parseEpgTime(timeStr) {
  // XMLTV time format: YYYYMMDDHHMMSS [+-]HHMM
  // Mit Timezone
  const m = timeStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{2})(\d{2})/);
  if (m) {
    const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const tzOffset = (+m[7]) * 60 + (+m[8]);
    return new Date(utc - tzOffset * 60000);
  }
  // Ohne Timezone
  const m2 = timeStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m2) return new Date(0);
  return new Date(Date.UTC(+m2[1], +m2[2] - 1, +m2[3], +m2[4], +m2[5], +m2[6]));
}

function formatEpgTime(timeStr) {
  const d = parseEpgTime(timeStr);
  if (d.getTime() === 0) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function buildEpgIndex() {
  tvEpgIndex = new Map();
  const normId = (id) => id.replace(/@[^.@]*/g, '').toLowerCase().trim();
  tvEpgData.forEach(e => {
    const key = normId(e.channelId);
    if (!tvEpgIndex.has(key)) tvEpgIndex.set(key, []);
    tvEpgIndex.get(key).push(e);
  });
  // Sort by start time for each channel
  tvEpgIndex.forEach(entries => {
    entries.sort((a, b) => parseEpgTime(a.start) - parseEpgTime(b.start));
  });
}

// ── TV Keyboard shortcut ──

// ── Shortcuts overlay ──
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
      if (svc) {
        navigateTo(svc);
      } else if (e.serviceKey === '__tv__') {
        openTvSidebar();
      }
    });

    historyList.appendChild(row);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function decodeEntities(str) {
  const div = document.createElement('div');
  div.innerHTML = str;
  return div.textContent || '';
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
webview.addEventListener('ipc-message', (e) => {
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
  const normId = (id) => id.replace(/@[^.@]*/g, '').toLowerCase().trim();
  const chNorm = normId(ch.tvgId);
  let epgTitle = '', epgStart = '', epgEnd = '', epgNext = '';
  const epgList = tvEpgIndex && tvEpgIndex.get(chNorm);
  const currentIdx = epgList ? epgList.findIndex(e => {
    const s = parseEpgTime(e.start);
    const t = parseEpgTime(e.stop);
    return s <= now && t >= now;
  }) : -1;
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
    webview.executeJavaScript("window.postMessage(" + JSON.stringify(data) + ",'*')");
  } catch (err) { console.warn('sendEpgUpdate failed:', err); }
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

// TV event listeners
tvSidebarClose.addEventListener('click', closeTvSidebar);
tvSidebarManage.addEventListener('click', openTvModal);
tvSidebarEpgRefresh.addEventListener('click', refreshEpg);
tvModalClose.addEventListener('click', closeTvModal);
tvModalOverlay.addEventListener('click', (e) => {
  if (e.target === tvModalOverlay) closeTvModal();
});
tvModalSave.addEventListener('click', saveTvSource);

tvFileBtn.addEventListener('click', () => {
  window.electronAPI.pickM3uFile().then(filePath => {
    if (filePath) tvInputUrl.value = filePath;
  });
});

tvInputName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tvInputUrl.focus();
});
tvInputUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tvInputEpgUrl.focus();
});
tvInputEpgUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveTvSource();
});

tvSidebarTrigger.addEventListener('mouseenter', () => {
  if (!tvSidebarOpen) openTvSidebar();
});

tvSearchInput.addEventListener('input', () => {
  tvSearchFilter = tvSearchInput.value;
  renderTvChannels();
});

tvSearchInput.addEventListener('keydown', (e) => {
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
tvChModalOverlay.addEventListener('click', (e) => {
  if (e.target === tvChModalOverlay) closeTvChEditor();
});
tvChModalSave.addEventListener('click', saveTvChEditor);
tvChSearch.addEventListener('input', renderTvChEditor);
tvChSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    tvChSearch.value = '';
    renderTvChEditor();
    tvChSearch.blur();
  }
});

// Close sidebar when clicking outside
document.addEventListener('click', (e) => {
  if (tvSidebarOpen &&
      !tvSidebar.contains(e.target) &&
      !tvBtn.contains(e.target) &&
      !tvSidebarTrigger.contains(e.target)) {
    closeTvSidebar();
  }
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
    if (modalOverlay.classList.contains('open')) {
      closeModal();
      return true;
    }
    if (tvSidebarOpen) {
      closeTvSidebar();
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

const cleanupUpdateStatus = window.electronAPI.onUpdateStatus((status) => {
  if (status.type === 'available') {
    updateAvailableVersion = status.version;
    setUpdateState('available');
  } else if (status.type === 'not-available') {
    setUpdateState('uptodate');
  } else if (status.type === 'error') {
    setUpdateState('uptodate');
  } else if (status.type === 'progress') {
    updateBtn._percent = status.percent;
    setUpdateState('progress');
  } else if (status.type === 'downloaded') {
    setUpdateState('downloaded');
  }
});

updateBtn.addEventListener('click', async () => {
  if (updateChecking || updateBtn.disabled) return;
  if (updateAvailableVersion) {
    if (confirm(`Update v${updateAvailableVersion} installieren?\nDie App wird nach der Installation neugestartet.`)) {
      updateBtn.disabled = true;
      updateBtn.title = 'Installiere…';
      const result = await window.electronAPI.applyUpdate(updateAvailableVersion);
      if (!result.success && !result.downloading) {
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
  settingsOverlay.classList.add('open');
}

function closeSettings() {
  settingsOverlay.classList.remove('open');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => {
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
  setTimeout(() => { backupBtn.disabled = false; }, 2000);
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
  setTimeout(() => { restoreBtn.disabled = false; }, 3000);
});

// Services laden
window.electronAPI.getServices().then((svcs) => {
  services = svcs;
  renderNav();
  tvBtn = document.getElementById('tvBtn');
});

window.electronAPI.onServicesChanged((svcs) => {
  services = svcs;
  renderNav();
  tvBtn = document.getElementById('tvBtn');
  renderServiceList();
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

// TV Sources laden
window.electronAPI.getTvSources().then((sources) => {
  tvSources = sources;
  tvSelectedSourceIds = sources.map(s => s.id);
});

window.electronAPI.onTvSourcesChanged((sources) => {
  // Nur bei strukturellen Änderungen (neue/entfernte Quelle, URL-Änderung) neu laden,
  // nicht bei reinen sortOrder/favorites-Änderungen (Drag&Drop)
  const structuralChange = sources.length !== tvSources.length
    || sources.some(s => {
      const old = tvSources.find(t => t.id === s.id);
      return !old || old.url !== s.url || old.epgUrl !== s.epgUrl;
    });
  tvSources = sources;
  tvSelectedSourceIds = tvSelectedSourceIds.filter(id => sources.some(s => s.id === id));
  if (!tvSelectedSourceIds.length && sources.length) tvSelectedSourceIds = sources.map(s => s.id);

  renderTvSourceList();
  if (tvSidebarOpen) {
    renderSourcePills();
    if (structuralChange) loadTvChannels(true);
    else renderTvChannels();
  }
});
