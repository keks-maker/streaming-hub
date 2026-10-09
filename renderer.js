// v0.3.9. – Fix: Zurück innerhalb eines Dienstes (did-navigate-in-page-Tracking) + TV-Zustand mit Kanal-ID
const {
  escapeHtml,
  normalizeUrl,
  formatTimestamp,
  parseEpgTime,
  formatEpgTime,
  getMediathekForChannel,
  isFavorite,
  buildChannelList,
  getNextChannelId,
  applyChannelOverrides,
  applySortOrder,
} = require('@streaming-hub/typed-core');
const logger = require('./logger.js');
const epgAdapter = require('./lib/epg/renderer-adapter.js');
const { createSettingsView } = require('./settings-view.js');
const { createEpgView } = require('./epg-view.js');
const { createTvSourcesView } = require('./settings-tv-sources.js');
const { createTvChannelsView } = require('./settings-tv-channels.js');
const { orderFavoriteChannels } = require('./lib/settings-channel-logic.js');
const {
  formatDuration,
  currentEpgStopMs,
  isProbablyNetworkPath,
} = require('./lib/recorder/ui-model.js');
const scheduleUi = require('./lib/recorder/schedule-ui-model.js');
const { createDashboardHub } = require('./dashboard-hub-view.js');
const { renderUpdateNotes } = require('./update-notes-model.js');

function safeResourceUrl(value, { allowRelative = true } = {}) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value, window.location.href);
    if (parsed.username || parsed.password) return '';
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    if (allowRelative && parsed.protocol === 'file:') return parsed.toString();
  } catch {}
  return '';
}

function safeColor(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{6,8}$/i.test(value) ? value : fallback;
}

let services = [];
let webviewReady = false;
let pendingNav = null;
let pipActive = false;
let currentProvider = '';
let currentDashboardGroup = null;

// TV state
let tvSources = [];
let tvChannels = [];
let tvActiveChannelId = null;
let tvEpgRefreshing = false;
let tvSourcesRefreshing = false;
let tvSourceStatus = 'idle';
let tvEpgStatus = 'idle';
let tvEpgLoadedAt = null;
let settingsTvSourcesView = null;
let settingsTvChannelsView = null;
let tvSourceErrors = [];
let tvEpgErrors = [];
// EPG kommt ausschließlich aus dem Main (epg:now-next, epg:channels, epg:range-many); der Renderer lädt/parst nichts.
let epgNowNextCache = new Map(); // normId -> { current, next } (Main-Slots in ms)
let settingsEpgList = []; // [{ normId, channelId, sampleTitle }] für die Settings-Zuordnung
let settingsEpgIds = null; // Set<normId> oder null (kein EPG)

let tvMode = localStorage.getItem('tvMode') || 'free';

// ═══ Aufnahmen (Phase 1c): Host-seitiger Recording-State ═══
// Der Renderer besitzt die Engine-IPC (preload electronAPI) und versorgt
// tv.html mit Status-Snapshots (type 'recording-status' via tv-player-command)
// sowie die Bibliothek/Settings-Screens. Konsumiert NUR die Engine
// (recording:*), keine Aufnahme-Logik hier.
let recordingState = { active: [], remuxing: [] };

const recordingStatusListeners = [];
function onRecordingStatusChanged(cb) {
  recordingStatusListeners.push(cb);
}
function notifyRecordingStatusListeners() {
  for (const cb of recordingStatusListeners) {
    try { cb(recordingState); } catch (_e) { /* Listener-Fehler sollen State-Loop nicht killen */ }
  }
}

function activeRecordingForChannel(channelId) {
  if (!channelId) return null;
  return (recordingState.active || []).find(a => a.channelId === channelId) || null;
}

function recordingActive() {
  return !!(recordingState.active && recordingState.active.length);
}

// NavBar-Indikator (P21): Punkt am LiveTV-Eintrag, solange eine Aufnahme läuft (Punkt ohne Zahl, Screenreader-Text)
function updateNavRecordingIndicator() {
  const running = recordingActive();
  const dot = nav.querySelector('.nav-live-dot');
  const sr = nav.querySelector('.nav-live-sr');
  if (dot) dot.hidden = !running;
  if (sr) sr.hidden = !running;
}

/**
 * Laufende + nächste Sendung eines Kanals aus dem Jetzt/Nächste-Cache (Einträge mit XMLTV-Zeitstrings) —
 * Basis für Auto-Stopp „bis zum Ende der Sendung“ (Konzept §3.1).
 */
function epgListForChannel(ch) {
  if (!ch) return [];
  const { current, next } = epgAdapter.resolveNowNext(epgNowNextCache.get(epgAdapter.channelEpgKey(ch)), Date.now());
  return epgAdapter.slotsToXmltvEntries([current, next]);
}

/** Titel der laufenden Sendung (für Aufnahme-Metadaten). */
function currentEpgTitle(ch) {
  const now = new Date();
  const list = epgListForChannel(ch);
  const cur = list.find(e => parseEpgTime(e.start) <= now && parseEpgTime(e.stop) >= now);
  return cur ? cur.title : '';
}

/**
 * A-Fail R2-FB-01 (t_d6ee955e): EPG-Status-Kontext eines Kanals (vier
 * formatierte Felder) — geteilt zwischen selectTvChannel (URL-Params),
 * sendEpgUpdate/pushEpgToTvView (Duplikatblöcke) und der neuen
 * channel-context-Antwort (pushChannelContextToTvView).
 */
function buildEpgContextForChannel(ch, now = new Date()) {
  const epgList = epgListForChannel(ch);
  let epgTitle = '',
    epgStart = '',
    epgEnd = '',
    epgNext = '';
  const currentIdx = epgList.findIndex(e => parseEpgTime(e.start) <= now && parseEpgTime(e.stop) >= now);
  if (currentIdx !== -1) {
    const cur = epgList[currentIdx];
    epgTitle = cur.title;
    epgStart = formatEpgTime(cur.start);
    epgEnd = formatEpgTime(cur.stop);
    if (currentIdx + 1 < epgList.length) {
      epgNext = epgList[currentIdx + 1].title;
    }
  }
  return { epgTitle, epgStart, epgEnd, epgNext };
}

/** Kleine Einblendung (Inline-Meldung im tvView-Bereich). */
function showTvToast(message) {
  try {
    const host = document.getElementById('tvView');
    let toast = document.getElementById('tvRecToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'tvRecToast';
      toast.style.cssText =
        'position:absolute;left:50%;bottom:96px;transform:translateX(-50%);' +
        'background:rgba(0,0,0,0.85);color:#fff;padding:10px 18px;border-radius:10px;' +
        'font-size:14px;z-index:40;pointer-events:none;max-width:70%;text-align:center;';
      if (host && host.parentElement) host.parentElement.appendChild(toast);
      else document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    clearTimeout(showTvToast._timer);
    showTvToast._timer = setTimeout(() => {
      toast.style.opacity = '0';
    }, 4000);
  } catch (_e) {
    logger.warn('showTvToast fehlgeschlagen:', _e?.message || _e);
  }
}

function applyRecordingState(status) {
  recordingState = status && typeof status === 'object'
    ? { active: Array.isArray(status.active) ? status.active : [], remuxing: Array.isArray(status.remuxing) ? status.remuxing : [] }
    : { active: [], remuxing: [] };
  notifyRecordingStatusListeners();
  pushRecordingStatusToTvView();
  updateRecordingsScreenIfVisible();
  updateNavRecordingIndicator();
  scheduleDashboardHubRefresh();
}

function pushRecordingStatusToTvView() {
  try {
    tvView.send('tv-player-command', {
      type: 'recording-status',
      status: recordingState,
    });
  } catch (_e) {
    // tvView noch nicht bereit / about:blank — nächster Snapshot folgt
  }
}

/**
 * A-Fail R2-FB-01 (t_d6ee955e): Antwort auf channel-context aus tv.html —
 * dieselbe Struktur wie der switch-channel-Pfad in selectTvChannel, aber OHNE
 * channelList (nicht anzeigen). tv.html wendet daraus NUR recChannelCtx +
 * dvrBarMode an (kein zweiter HLS-Load).
 */
function pushChannelContextToTvView() {
  const ch = tvChannels.find(c => c.id === tvActiveChannelId);
  if (!ch) return;
  const ctx = buildEpgContextForChannel(ch);
  try {
    tvView.send('tv-player-command', {
      type: 'switch-channel',
      url: ch.url,
      name: ch.name,
      logo: ch.logo || '',
      channelId: ch.id,
      epg: ctx.epgTitle,
      epgStart: ctx.epgStart,
      epgEnd: ctx.epgEnd,
      epgNext: ctx.epgNext,
      dvr: dvrBarMode(),
      contextOnly: true,
    });
  } catch (_e) {
    // tvView noch nicht bereit — nach did-finish-load folgt der normale Pfad
  }
}

/**
 * Fix-Set 3 · Punkt 5: Phase-Notizen (stopping/done) an den TV-Player —
 * der Chip geht dort in den Beenden-Zustand („Wird beendet…"), statt bis
 * zum Remux-Abschluss eine eingefrorene Uhr zu zeigen.
 */
function pushRecordingPhaseToTvView(payload) {
  try {
    tvView.send('tv-player-command', { type: 'recording-phase', phase: payload });
  } catch (_e) { /* tvView noch nicht bereit */ }
}

/**
 * Soft-Limit-Dialog (L2): Das Parallel-Limit ist erreicht — „Trotzdem
 * aufnehmen“ (force) oder „Verwerfen“. Nur Text, kein innerHTML.
 */
let recLimitPending = null; // { promise, finish } des gerade offenen Dialogs

function closeRecordingLimitDialog(decision = false) {
  if (recLimitPending) recLimitPending.finish(decision);
}

function askRecordingLimitOverride({ limit, active }) {
  // Ein offener Dialog wird wiederverwendet: kein zweites Listener-Paar,
  // ein weiterer Start wartet auf dieselbe Entscheidung.
  if (recLimitPending) return recLimitPending.promise;
  const overlay = document.getElementById('recLimitOverlay');
  const text = document.getElementById('recLimitText');
  const forceBtn = document.getElementById('recLimitForce');
  const discardBtn = document.getElementById('recLimitDiscard');
  if (!overlay || !text || !forceBtn || !discardBtn) return Promise.resolve(false);
  text.textContent =
    `Es laufen bereits ${active} von ${limit} erlaubten Aufnahmen. ` +
    'Weitere Aufnahmen belasten Netzwerk und Festplatte.';
  const previousFocus = document.activeElement;
  const promise = new Promise(resolve => {
    const cleanup = () => {
      overlay.classList.remove('open');
      forceBtn.removeEventListener('click', onForce);
      discardBtn.removeEventListener('click', onDiscard);
      overlay.removeEventListener('keydown', onKey);
      recLimitPending = null;
      if (previousFocus && typeof previousFocus.focus === 'function') {
        try { previousFocus.focus(); } catch (_e) { /* Element weg */ }
      }
    };
    const finish = decision => {
      cleanup();
      resolve(decision);
    };
    const onForce = () => finish(true);
    const onDiscard = () => finish(false);
    // Esc = „Verwerfen“; Tab bleibt im Dialog (Fokus-Trap über beide Buttons)
    const onKey = ev => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      } else if (ev.key === 'Tab') {
        const order = [discardBtn, forceBtn];
        const idx = order.indexOf(document.activeElement);
        const next = ev.shiftKey ? (idx <= 0 ? order.length - 1 : idx - 1) : (idx === -1 || idx === order.length - 1 ? 0 : idx + 1);
        ev.preventDefault();
        order[next].focus();
      }
    };
    forceBtn.addEventListener('click', onForce);
    discardBtn.addEventListener('click', onDiscard);
    overlay.addEventListener('keydown', onKey);
    recLimitPending = { finish, promise: null };
  });
  recLimitPending.promise = promise;
  overlay.classList.add('open');
  discardBtn.focus();
  return promise;
}

/**
 * Startet eine Aufnahme über die Engine. untilEpgEnd nutzt das Ende der
 * laufenden Sendung (EPG) als Auto-Stopp: der Renderer gibt nur noch den
 * Zeitpunkt (stopAt) mit, den Stopp übernimmt der Main-Prozess (L1) — auch bei
 * geschlossenem Fenster. Ohne EPG verhält sich der Request wie „ab jetzt“
 * (Hinweis kommt bereits aus dem tv.html-Dialog).
 */
async function startRecordingFromRequest({
  channelId,
  channelName,
  epgTitle,
  epgDescription,
  untilEpgEnd = false,
  epgStopMs = null,
  startOffsetSec = 0,
} = {}) {
  const ch = channelId ? tvChannels.find(c => c.id === channelId) : null;
  const url = ch?.url;
  if (!url) throw new Error('Kein Stream für die Aufnahme verfügbar');
  const request = {
    sourceUrl: url,
    channelId: channelId || null,
    channelName: channelName || ch?.name || null,
    epgTitle: epgTitle || null,
    epgDescription: epgDescription || null,
    // Karte t_f36663be (Engine C): DVR-Rückstand in Sekunden — 0 = Live-Head.
    startOffsetSec: Number.isFinite(startOffsetSec) && startOffsetSec > 0 ? Math.floor(startOffsetSec) : 0,
  };
  if (untilEpgEnd && Number.isFinite(epgStopMs) && epgStopMs > Date.now()) request.stopAt = Math.floor(epgStopMs);
  let result = await window.electronAPI.startRecording(request);
  if (result?.code === 'PARALLEL_LIMIT') {
    const override = await askRecordingLimitOverride(result);
    if (!override) return { discarded: true };
    result = await window.electronAPI.startRecording({ ...request, force: true });
  }
  // Sofortiger Snapshot — die Engine-Events kommen zusätzlich asynchron.
  try {
    applyRecordingState(await window.electronAPI.getRecordingStatus());
  } catch (_e) { /* Event-Stream liefert den Status ohnehin */ }
  return result;
}

async function stopRecordingById(recId) {
  const result = await window.electronAPI.stopRecording(recId);
  try {
    applyRecordingState(await window.electronAPI.getRecordingStatus());
  } catch (_e) { /* s. o. */ }
  return result;
}

// Remux-Fortschritt aus den recording:status-Events ({recId, phase, percent,
// remainingSec}) — für die Status-Spalte der Aufnahmen-Bibliothek.
const remuxProgressMap = new Map(); // recId → { percent, remainingSec, ts }
let recordingsScreenRenderTs = 0;

function refreshRecordingSnapshot() {
  window.electronAPI
    .getRecordingStatus()
    .then(applyRecordingState)
    .catch(e => logger.warn('Recording-Snapshot fehlgeschlagen:', e?.message || e));
}

/**
 * Bibliothek neu zeichnen, wenn der Screen sichtbar ist (gedrosselt —
 * Remux-Progress-Events kommen im Sekundentakt).
 */
function updateRecordingsScreenIfVisible() {
  const now = Date.now();
  if (now - recordingsScreenRenderTs < 500) return;
  recordingsScreenRenderTs = now;
  // Eine offene Puffer-Bearbeitung in „Geplant“ wird nicht von Hintergrund-Events überzeichnet
  if (currentDashboardGroup === 'recording' && !(recordingDashboardTab === 'planned' && scheduleEditingId)) {
    renderRecordingDashboard();
  }
}

const overlayBar = document.getElementById('overlayBar');
const nav = document.getElementById('overlayNav');
const updateBtn = document.getElementById('updateBtn');
const dashboardUpdateSlot = document.getElementById('dashboardUpdateSlot');
const overlayUpdateSlot = document.getElementById('overlayUpdateSlot');

function placeUpdateButton(slot, inDashboard = false) {
  if (updateBtn.parentElement !== slot) slot.appendChild(updateBtn);
  updateBtn.classList.toggle('dashboard-update-btn', inDashboard);
}
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
    tvView.style.pointerEvents = 'auto';
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
const dashboardView = document.getElementById('dashboardView');
const dashboardEyebrow = document.getElementById('dashboardEyebrow');
const dashboardTitle = document.getElementById('dashboardTitle');
const dashboardCount = document.getElementById('dashboardCount');
const dashboardGrid = document.getElementById('dashboardGrid');
const dashboardEmpty = document.getElementById('dashboardEmpty');
const dashboardHub = document.getElementById('dashboardHub');
const dashboardHubCards = document.getElementById('dashboardHubCards');
const dashboardTvStatus = document.getElementById('dashboardTvStatus');
const dashboardTvStatusBtn = document.getElementById('dashboardTvStatusBtn');
const dashboardTvRefresh = document.getElementById('dashboardTvRefresh');
const dashboardPlayer = document.getElementById('dashboardPlayer');
const dashboardPlayerStage = document.getElementById('dashboardPlayerStage');
const dashboardPlayerClose = document.getElementById('dashboardPlayerClose');
const overlayLocation = document.getElementById('overlayLocation');
const backBtn = document.getElementById('backBtn');
// Fix-Set 4: settings-/pip-Buttons sind aus der Navbar entfernt; die Elemente
// existieren nicht mehr im DOM — die Verkabelung hier bleibt bewusst bestehen,
// behandelt null (Funktion schlummert im Hintergrund).
const shortcutsOverlay = document.getElementById('shortcutsOverlay');
const historyOverlay = document.getElementById('historyOverlay');
const historyBtn = document.getElementById('historyBtn');
const historyList = document.getElementById('historyList');
const historyClose = document.getElementById('historyClose');
const historyClear = document.getElementById('historyClear');
// EPG Overlay DOM
const epgOverlay = document.getElementById('epgOverlay');
let epgViewReady = false; // epgView wird weiter unten erzeugt; Navigationsfunktionen laufen auch davor

const dashboardTvSettings = document.getElementById('dashboardTvSettings');
if (dashboardTvSettings) dashboardTvSettings.addEventListener('click', () => openSettingsPage('livetv-channels'));
const dashboardTvRefreshLabel = dashboardTvRefresh.querySelector('.dashboard-hub-tool-label');
dashboardTvRefresh.addEventListener('click', async () => {
  dashboardTvRefresh.disabled = true;
  dashboardTvRefreshLabel.textContent = 'Wird aktualisiert…';
  try {
    await refreshEpg();
    renderDashboard('livetv');
  } finally {
    dashboardTvRefresh.disabled = false;
    dashboardTvRefreshLabel.textContent = 'EPG aktualisieren';
  }
});
dashboardTvStatusBtn.addEventListener('click', () => {
  dashboardTvStatus.classList.toggle('expanded');
});

// ── LiveTV-Hub (Etappe 3.6b): Einstiegskarten „Programmübersicht“ und „Aufnahmen“ ──
// Die Karten zeigen nur eine Statuszeile (keine Senderliste); Klick öffnet den Programmführer bzw. den Aufnahmen-Bereich.
const dashboardHubView = createDashboardHub(dashboardHubCards, {
  api: window.electronAPI,
  logger,
  getEpgInput: () => ({ favoriteCount: getOrderedFavoriteChannels().length, epgStatus: tvEpgStatus }),
  onOpenEpg: () => openEpgView(),
  onOpenRecordings: () => showDashboard('recording'),
});

function isLiveTvDashboardVisible() {
  return currentDashboardGroup === 'livetv' && !currentProvider;
}

// Statuszeile der Aufnahmen-Karte nachführen (Planung/Aufnahme-Events), gebündelt und nur bei sichtbarem LiveTV-Dashboard
let dashboardHubRefreshTimer = null;
function scheduleDashboardHubRefresh() {
  if (!isLiveTvDashboardVisible() || dashboardHubRefreshTimer) return;
  dashboardHubRefreshTimer = setTimeout(() => {
    dashboardHubRefreshTimer = null;
    if (isLiveTvDashboardVisible()) dashboardHubView.refresh();
  }, 250);
}
dashboardPlayerClose.addEventListener('click', closeDashboardPlayer);
dashboardPlayer.addEventListener('dblclick', closeDashboardPlayer);
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && activePreview?.fullscreen) closeDashboardPlayer();
});

// Mediathek mapping for EPG -> service search (now in typed-core tv.ts)

const chromeVer = window.electronAPI.chromeVersion || '148.0.0.0';
const uaMap = {
  linux: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`,
  darwin: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`,
  win32: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`,
};
const chromeUA = uaMap[window.electronAPI.platform] || uaMap.linux;
const safariUA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
let currentUA = chromeUA;

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

function renderDashboardTile(svc) {
  const group = svc.group === 'mediathek' ? 'Mediathek' : 'Streaming';
  const tile = document.createElement('button');
  tile.className = 'dashboard-tile is-loading';
  tile.type = 'button';
  tile.setAttribute('aria-label', `${svc.name} öffnen`);
  tile.style.setProperty('--tile-color', safeColor(svc.color, '#6c5ce7'));
  tile.innerHTML = `
    <span class="dashboard-tile-glow"></span>
    <span class="dashboard-tile-icon">
      <span class="dashboard-tile-fallback" aria-hidden="true">${escapeHtml((svc.name || '?').slice(0, 1).toUpperCase())}</span>
      <img alt="" loading="lazy">
    </span>
    <span class="dashboard-tile-content">
      <span class="dashboard-tile-name">${escapeHtml(svc.name)}</span>
      <span class="dashboard-tile-meta">${group}</span>
    </span>
    <span class="dashboard-tile-action">Öffnen</span>
  `;
  const icon = tile.querySelector('.dashboard-tile-icon');
  const image = tile.querySelector('img');
  const iconSrc = safeResourceUrl(getIconSrc(svc));
  if (iconSrc) image.src = iconSrc;
  image.addEventListener('load', () => tile.classList.remove('is-loading'));
  image.addEventListener('error', () => {
    image.remove();
    tile.classList.remove('is-loading');
    icon.classList.add('has-error');
  });
  tile.addEventListener('click', () => navigateTo(svc));
  return tile;
}

/** Laufende Sendung {start, stop, title, genre} (ms) aus dem Jetzt/Nächste-Cache oder null. */
function getCurrentEpg(ch) {
  return epgAdapter.resolveNowNext(epgNowNextCache.get(epgAdapter.channelEpgKey(ch)), Date.now()).current;
}

let activePreview = null;
let previewTimer = null;

function closeDashboardPlayer() {
  if (!activePreview || !activePreview.fullscreen) return;
  const { tile, video } = activePreview;
  if (document.fullscreenElement === dashboardPlayer) document.exitFullscreen().catch(() => {});
  dashboardPlayerStage.innerHTML = '';
  tile.prepend(video);
  tile.classList.remove('is-fullscreen');
  dashboardPlayer.style.display = 'none';
  activePreview.fullscreen = false;
}

function openDashboardPlayer(tile, ch) {
  if (!activePreview || activePreview.tile !== tile) {
    startLivePreview(tile, ch, true);
    return;
  }
  const { video } = activePreview;
  dashboardPlayerStage.appendChild(video);
  tile.classList.add('is-fullscreen');
  dashboardPlayer.style.display = '';
  activePreview.fullscreen = true;
  dashboardPlayer.requestFullscreen().catch(() => {});
}

function disposeDashboardPlayback() {
  if (activePreview?.fullscreen) closeDashboardPlayer();
  stopLivePreview();
}

function stopLivePreview() {
  if (activePreview?.fullscreen) return;
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  if (!activePreview) return;
  const { tile, video, hls } = activePreview;
  if (hls) hls.destroy();
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.remove();
  tile.classList.remove('is-previewing', 'is-preview-error');
  activePreview = null;
}

function startLivePreview(tile, ch, openAfterStart = false) {
  if (!ch.url || activePreview?.tile === tile) {
    if (openAfterStart && activePreview?.tile === tile) openDashboardPlayer(tile, ch);
    return;
  }
  stopLivePreview();
  previewTimer = setTimeout(() => {
    previewTimer = null;
    const video = document.createElement('video');
    video.className = 'dashboard-tv-preview';
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');
    tile.prepend(video);
    const preview = { tile, video, hls: null, fullscreen: false };
    activePreview = preview;
    tile.classList.add('is-previewing');
    if (openAfterStart) {
      video.addEventListener(
        'playing',
        () => {
          if (activePreview === preview && !preview.fullscreen) openDashboardPlayer(tile, ch);
        },
        { once: true },
      );
    }
    const fail = () => {
      if (activePreview !== preview) return;
      tile.classList.add('is-preview-error');
      stopLivePreview();
    };
    video.addEventListener('error', fail, { once: true });
    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false, maxBufferLength: 8, liveSyncDurationCount: 2 });
      preview.hls = hls;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) fail();
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(fail));
      hls.loadSource(ch.url);
      hls.attachMedia(video);
    } else {
      video.src = ch.url;
      video.play().catch(fail);
    }
  }, 350);
}

function renderLiveTvTile(ch) {
  const source = tvSources.find(item => item.id === ch.sourceId);
  const current = getCurrentEpg(ch);
  const start = current ? current.start : 0;
  const stop = current ? current.stop : 0;
  const now = Date.now();
  const progress = start && stop > start ? Math.min(100, Math.max(0, ((now - start) / (stop - start)) * 100)) : 0;
  const tile = document.createElement('button');
  tile.className = 'dashboard-tile dashboard-tv-tile';
  tile.type = 'button';
  tile.setAttribute('aria-label', `${ch.name} öffnen`);
  tile.style.setProperty('--tile-color', source?.color || '#6c5ce7');
  tile.innerHTML = `
    <span class="dashboard-tv-badge">LIVE</span>
    <span class="dashboard-tile-glow"></span>
    <span class="dashboard-tile-icon">
      <span class="dashboard-tile-fallback" aria-hidden="true">${escapeHtml((ch.name || '?').slice(0, 1).toUpperCase())}</span>
      <img alt="" loading="lazy">
    </span>
    <span class="dashboard-tile-content">
      <span class="dashboard-tile-name">${escapeHtml(ch.name)}</span>
      <span class="dashboard-tile-meta">${current ? escapeHtml(current.title) : 'Kein EPG verfügbar'}</span>
      ${current ? `<span class="dashboard-tv-progress"><span style="width:${progress.toFixed(1)}%"></span></span>` : ''}
    </span>
    <span class="dashboard-tile-action">Sender öffnen</span>
  `;
  const image = tile.querySelector('img');
  const icon = tile.querySelector('.dashboard-tile-icon');
  const logoSrc = safeResourceUrl(ch.logo);
  if (logoSrc) image.src = logoSrc;
  image.addEventListener('error', () => {
    image.remove();
    icon.classList.add('has-error');
  });
  tile.addEventListener('mouseenter', () => startLivePreview(tile, ch));
  tile.addEventListener('mouseleave', stopLivePreview);
  tile.addEventListener('focus', () => startLivePreview(tile, ch));
  tile.addEventListener('blur', stopLivePreview);
  tile.addEventListener('click', () => selectTvChannel(ch, { suppressChannelList: true }));
  return tile;
}

function getOrderedFavoriteChannels(channels = tvChannels) {
  return orderFavoriteChannels(channels, tvSources);
}

function renderLiveTvDashboard() {
  const favorites = getOrderedFavoriteChannels();
  dashboardHub.hidden = false;
  dashboardGrid.innerHTML = '';
  dashboardCount.textContent = `${favorites.length} ${favorites.length === 1 ? 'Favorit' : 'Favoriten'}`;
  if (!favorites.length) {
    dashboardEmpty.textContent = tvChannels.length
      ? 'Noch keine Favoritensender vorhanden. Verwalte deine Favoriten in den TV-Einstellungen.'
      : 'Keine Sender geladen.';
    dashboardEmpty.style.display = '';
  } else {
    dashboardEmpty.style.display = 'none';
    favorites.forEach(ch => dashboardGrid.appendChild(renderLiveTvTile(ch)));
  }
  dashboardHubView.render();
}

function renderStartDashboard() {
  currentDashboardGroup = null;
  settingsPanel.hidden = true;
  settingsPanelHost.hidden = true;
  if (settingsPanel.parentNode !== settingsPanelPlaceholder.parentNode)
    settingsPanelPlaceholder.parentNode.insertBefore(settingsPanel, settingsPanelPlaceholder.nextSibling);
  dashboardView.classList.remove('settings-dashboard');
  dashboardView.classList.remove('recordings-dashboard');
  dashboardEyebrow.textContent = 'Streaming Hub';
  dashboardTitle.textContent = 'Was möchtest du sehen?';
  dashboardCount.textContent = '';
  dashboardGrid.setAttribute('aria-label', 'Bereiche');
  dashboardGrid.innerHTML = '';
  dashboardHub.hidden = true;
  dashboardEmpty.style.display = 'none';
  const sections = [
    { key: 'livetv', label: 'LiveTV', icon: 'tv-icon.png', color: '#8b5cf6' },
    { key: 'streaming', label: 'Streaming', icon: 'netflix.png', color: '#e50914' },
    { key: 'mediathek', label: 'Mediatheken', icon: 'ard.png', color: '#0ea5e9' },
    // 3.6b: keine Kachel „Aufnahmen“ mehr (wie der NavBar-Eintrag, P21); der Bereich ist über die Karte im LiveTV-Dashboard erreichbar.
    { key: 'settings', label: 'Einstellungen', icon: null, color: '#64748b' },
  ];
  sections.forEach(section => {
    const tile = document.createElement('button');
    tile.className = `dashboard-tile dashboard-section-tile dashboard-section-${section.key}`;
    tile.type = 'button';
    tile.dataset.section = section.key;
    tile.style.setProperty('--tile-color', section.color);
    tile.innerHTML = `<span class="dashboard-tile-glow"></span><span class="dashboard-section-tile-art" aria-hidden="true"><span class="dashboard-section-tile-art-shape"></span><span class="dashboard-section-tile-art-detail"></span></span><span class="dashboard-section-tile-icon">${section.icon ? `<img src="assets/icons/${section.icon}" alt="">` : '⚙'}</span><span class="dashboard-tile-content"><span class="dashboard-tile-name">${section.label}</span><span class="dashboard-tile-meta">Bereich öffnen</span></span>`;
    tile.addEventListener('click', () => {
      overlayBar.classList.remove('nav-collapsed');
      showDashboard(section.key);
    });
    dashboardGrid.appendChild(tile);
  });
  dashboardView.style.display = '';
  dashboardView.classList.add('start-page');
  welcomeScreen.style.display = 'none';
  overlayBar.classList.add('start-page');
  overlayBar.classList.remove('nav-collapsed', 'is-fullscreen');
  placeUpdateButton(dashboardUpdateSlot, true);
}

function renderDashboard(groupKey, opts = {}) {
  if (!dashboardView) return;
  if (groupKey === 'start') {
    renderStartDashboard();
    return;
  }
  currentDashboardGroup = groupKey;
  dashboardView.classList.remove('start-page');
  overlayBar.classList.remove('start-page');
  placeUpdateButton(overlayUpdateSlot);
  dashboardView.classList.toggle('settings-dashboard', groupKey === 'settings');
  dashboardView.classList.toggle('recordings-dashboard', groupKey === 'recording');
  const isTv = groupKey === 'livetv';
  const isSettings = groupKey === 'settings';
  const isRecording = groupKey === 'recording';
  const items = isTv || isSettings ? [] : services.filter(s => (s.group || 'streaming') === groupKey);
  const title = isSettings ? 'Einstellungen' : isTv ? 'LiveTV' : isRecording ? 'Aufnahmen' : groupKey === 'mediathek' ? 'Mediatheken' : 'Streaming';
  dashboardEyebrow.textContent = isSettings
    ? 'Streaming Hub'
    : isTv
      ? 'Live Fernsehen'
      : isRecording
        ? 'Deine Aufnahmen'
        : groupKey === 'mediathek'
          ? 'Deine Mediatheken'
          : 'Deine Streamingdienste';
  dashboardTitle.textContent = title;
  dashboardHub.hidden = !isTv;
  dashboardCount.textContent = isTv || isSettings || isRecording ? '' : `${items.length} ${items.length === 1 ? 'Dienst' : 'Dienste'}`;
  dashboardGrid.setAttribute('aria-label', title);
  settingsPanelHost.hidden = groupKey !== 'settings';
  dashboardGrid.innerHTML = '';
  dashboardEmpty.style.display = 'none';
  if (isSettings) {
    settingsPanelHost.hidden = false;
    renderSettingsServices();
    settingsAddForm.style.display = 'none';
    document.querySelector('input[name="tvMode"][value="' + tvMode + '"]').checked = true;
    settingsPanel.hidden = false;
    settingsPanelHost.appendChild(settingsPanel);
    settingsView.showPage(opts.page);
    settingsTvSourcesView.render();
    // Aufnahmen-Settings (Phase 1c): Speicherort + ffmpeg-Diagnose laden
    if (typeof loadRecordingSettingsUi === 'function') loadRecordingSettingsUi();
    loadEpgStartViewUi();
  } else if (isTv) {
    renderLiveTvDashboard();
  } else if (isRecording) {
    // Aufnahmen-Dashboard (Fix-Set 4): reguläre View, kein Overlay
    renderRecordingDashboard();
  } else if (!items.length) {
    dashboardEmpty.textContent = 'Keine Dienste konfiguriert.';
    dashboardEmpty.style.display = '';
  } else {
    items.forEach(svc => dashboardGrid.appendChild(renderDashboardTile(svc)));
  }
  dashboardView.style.display = '';
  welcomeScreen.style.display = 'none';
}

// Deep-Link in die Einstellungen (page: Schlüssel aus SETTINGS_NAV, z. B. 'livetv-channels').
function openSettingsPage(page) {
  overlayBar.classList.remove('nav-collapsed');
  showDashboard('settings', { page });
}

function showDashboard(groupKey, opts = {}) {
  closeEpgForNavigation();
  if (!restoringNav) pushNavState();
  disposeDashboardPlayback();
  currentProvider = '';
  currentDashboardGroup = groupKey;
  lastMediaTitle = '';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const activeSection = nav.querySelector(`[data-section="${groupKey}"]`);
  if (activeSection) activeSection.classList.add('active');
  switchWebview(false);
  contentView.style.opacity = '0';
  contentView.style.pointerEvents = 'none';
  tvView.style.opacity = '0';
  tvView.style.pointerEvents = 'none';
  webview = contentView;
  renderDashboard(groupKey, opts);
  overlayLocation.textContent =
    groupKey === 'start'
      ? 'Startseite'
      : groupKey === 'settings'
        ? 'Einstellungen'
        : groupKey === 'livetv'
          ? 'LiveTV'
          : groupKey === 'mediathek'
            ? 'Mediatheken'
            : groupKey === 'recording'
              ? 'Aufnahmen'
              : 'Streaming';
  overlayBar.classList.add('always-visible');
  overlayBar.classList.remove('nav-collapsed', 'is-fullscreen');
  if (groupKey === 'livetv') {
    ensureTvDataLoaded();
    dashboardHubView.refresh();
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

  const groups = [
    { key: 'livetv', label: 'LiveTV', icon: 'tv-icon.png' },
    { key: 'streaming', label: 'Streaming', icon: 'netflix.png' },
    { key: 'mediathek', label: 'Mediatheken', icon: 'ard.png' },
    // 3.6b (P21): kein Aufnahmen-Eintrag mehr; der Bereich ist über die Karte im LiveTV-Dashboard erreichbar.
  ];

  groups.forEach(group => {
    const btn = document.createElement('button');
    btn.className = 'nav-item nav-section-item';
    btn.type = 'button';
    btn.dataset.section = group.key;
    btn.innerHTML = `<span class="nav-section-icon"><img src="assets/icons/${group.icon}" alt=""></span><span class="nav-section-label">${group.label}</span>`;
    btn.addEventListener('click', () => showDashboard(group.key));
    if (group.key === 'livetv') {
      // Aufnahme-Indikator (P21): Punkt ohne Zahl, solange eine Aufnahme läuft; Screenreader-Text statt Farbe allein
      const icon = btn.querySelector('.nav-section-icon');
      const dot = document.createElement('span');
      dot.className = 'nav-live-dot';
      dot.hidden = true;
      dot.setAttribute('aria-hidden', 'true');
      const sr = document.createElement('span');
      sr.className = 'sr-only nav-live-sr';
      sr.hidden = true;
      sr.textContent = 'Aufnahme läuft';
      icon.append(dot, sr);
    }
    nav.appendChild(btn);
  });

  const settingsItem = document.createElement('button');
  settingsItem.className = 'nav-item nav-settings-item';
  settingsItem.type = 'button';
  settingsItem.title = 'Einstellungen';
  settingsItem.innerHTML = `<span class="nav-section-icon">⚙</span><span class="nav-section-label">Einstellungen</span>`;
  settingsItem.dataset.section = 'settings';
  settingsItem.addEventListener('click', () => showDashboard('settings'));
  nav.appendChild(settingsItem);
  nav.appendChild(overlayUpdateSlot);
  updateNavRecordingIndicator();
}

function createDivider() {
  const d = document.createElement('div');
  d.className = 'nav-divider';
  return d;
}

function createGroupLabel(text, groupKey) {
  const l = document.createElement('button');
  l.className = 'nav-group-label';
  l.type = 'button';
  l.textContent = text;
  l.setAttribute('aria-label', `${text} anzeigen`);
  l.addEventListener('click', () => showDashboard(groupKey));
  return l;
}

// ── Zurück-Navigation (Ansichts-Historie) ──
// Jeder Ansichtswechsel UND jede Navigation innerhalb eines Dienstes legt den
// vorherigen Zustand auf einen Stack. "Zurück" stellt ihn wiederher – inklusive
// der zuletzt besuchten URL, sodass man exakt dorthin zurückkehrt, wo man war.
let navStack = []; // { kind: 'start' | 'service' | 'tv', id?, url? }
let restoringNav = false;
let lastUrlByService = {}; // serviceId → zuletzt geladene/besuchte URL (auch SPA-intern)

function currentNavState() {
  if (currentProvider === '__tv__') {
    // Kanal-ID mitspeichern, damit "Zurück" exakt den letzten Sender öffnet
    return { kind: 'tv', id: tvActiveChannelId || null };
  }
  if (!currentProvider) {
    return currentDashboardGroup ? { kind: 'dashboard', group: currentDashboardGroup } : { kind: 'start' };
  }
  return { kind: 'service', id: currentProvider, url: lastUrlByService[currentProvider] || null };
}

function pushNavState() {
  const st = currentNavState();
  const top = navStack[navStack.length - 1];
  // Keine Duplikate direkt hintereinander (z. B. Kanalwechsel im TV)
  if (top && JSON.stringify(top) === JSON.stringify(st)) return;
  navStack.push(st);
  if (navStack.length > 50) navStack.shift();
  updateBackBtn();
}

function updateBackBtn() {
  if (!backBtn) return;
  backBtn.style.display = navStack.length ? '' : 'none';
  overlayBar.classList.toggle('has-back', navStack.length > 0);
}

function goBack() {
  const target = navStack.pop();
  updateBackBtn();
  if (!target) return;
  restoringNav = true;
  try {
    if (target.kind === 'service') {
      const svc = services.find(s => s.id === target.id);
      // Zuletzt besuchte URL wiederherstellen (auch SPA-intern); Fallbacks:
      // Stack-URL → lastUrlByService → Basis-URL des Dienstes.
      const url = target.url || lastUrlByService[target.id] || (svc ? normalizeUrl(svc.url) : '');
      if (url) {
        navigateTo({ id: target.id, url });
      } else {
        goToStartPage();
      }
    } else if (target.kind === 'tv') {
      // Zuletzt aktiven Sender wiederherstellen (per gespeicherter Kanal-ID)
      const ch = tvChannels.find(c => c.id === target.id) || tvChannels.find(c => c.id === tvActiveChannelId);
      if (ch) {
        selectTvChannel(ch, { suppressChannelList: true });
      } else {
        goToStartPage();
      }
    } else if (target.kind === 'dashboard') {
      showDashboard(target.group);
    } else {
      goToStartPage();
    }
  } finally {
    restoringNav = false;
  }
}

function handleBackNavigation() {
  if (
    webviewReady &&
    currentProvider &&
    currentProvider !== '__tv__' &&
    webview.getURL() !== 'about:blank' &&
    webview.canGoBack()
  ) {
    webview.goBack();
    return true;
  }

  if (navStack.length) {
    goBack();
    return true;
  }

  return false;
}

backBtn.addEventListener('click', handleBackNavigation);

function goToStartPage() {
  showDashboard('start');
}

function navigateTo(svc) {
  closeEpgForNavigation();
  if (!restoringNav) pushNavState();
  disposeDashboardPlayback();
  dashboardView.classList.remove('start-page');
  overlayBar.classList.remove('start-page');
  placeUpdateButton(overlayUpdateSlot);
  currentUA = svc.id === 'magentatv' ? safariUA : chromeUA;
  currentProvider = svc.id;
  currentDashboardGroup = null;
  lastMediaTitle = '';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const btn = nav.querySelector(`.nav-item[data-provider="${svc.id}"]`);
  if (btn) btn.classList.add('active');
  switchWebview(false);
  if (dashboardView) {
    dashboardView.style.display = 'none';
    dashboardView.classList.remove('settings-dashboard');
    dashboardView.classList.remove('recordings-dashboard');
  }
  welcomeScreen.style.display = 'none';
  overlayBar.classList.add('nav-collapsed');
  overlayBar.classList.remove('is-fullscreen');
  const targetUrl = normalizeUrl(svc.url);
  lastUrlByService[svc.id] = targetUrl;
  if (webviewReady) {
    try {
      webview.loadURL(targetUrl);
    } catch (e) {
      logger.warn('loadURL failed:', targetUrl, e);
    }
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
      const iconSrc = safeResourceUrl(getIconSrc(svc));
      const color = safeColor(svc.color, '#6c5ce7');
      row.innerHTML = `
        <img class="service-row-icon" alt="" style="background:${color}33;border-color:${color}66">
        <span class="service-row-name">${escapeHtml(svc.name)}</span>
        <button class="service-row-remove" data-id="${escapeHtml(svc.id)}" title="Entfernen">&times;</button>
      `;
      if (iconSrc) row.querySelector('.service-row-icon').src = iconSrc;
      row.querySelector('.service-row-remove').addEventListener('click', () => {
        window.electronAPI.removeService(svc.id);
      });
      container.appendChild(row);
    });
  }

  renderList(streamingList, streaming);
  renderList(mediathekList, mediathek);
}

// ═══ Settings: Aufnahmen — Speicherort + ffmpeg-Diagnose (Phase 1c, §3.4) ═══
// Netzwerkpfade sind erlaubt; Validierung (beschreibbar? Platz?) macht der
// Main-Process beim Setzen. Warnhinweis bei Netzwerkpfad-Heuristik hier.
const recPathInput = document.getElementById('recPathInput');
const recPathPickBtn = document.getElementById('recPathPickBtn');
const recPathSaveBtn = document.getElementById('recPathSaveBtn');
const recPathResetBtn = document.getElementById('recPathResetBtn');
const recPathHint = document.getElementById('recPathHint');
const recPathWarn = document.getElementById('recPathWarn');
const recFfmpegStatus = document.getElementById('recFfmpegStatus');

function formatFreeBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes === null) return 'Platz: unbekannt';
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GiB frei`;
  const mib = bytes / 1024 ** 2;
  return `${Math.max(0, Math.round(mib))} MiB frei`;
}

function describeStorageRoot(info) {
  const parts = [];
  parts.push(info.isDefault ? 'Standard-Speicherort' : 'Eigener Speicherort');
  parts.push(formatFreeBytes(info.freeBytes));
  return parts.join(' · ');
}

async function loadRecordingSettingsUi() {
  loadRecordingLimitsUi();
  loadWakeUi();
  loadEpgCacheStatusUi();
  try {
    const info = await window.electronAPI.getRecordingStorageRoot();
    recPathInput.value = info.root;
    recPathHint.textContent = describeStorageRoot(info);
    recPathWarn.style.display = info.network ? '' : 'none';
    recPathWarn.textContent = info.network
      ? '⚠ Netzwerkpfad erkannt: Aufnahmequalität hängt von der Verbindung ab. Bei Verbindungsabbruch versucht die App, den Stream wiederzufinden.'
      : '';
  } catch (e) {
    recPathHint.textContent = 'Speicherort konnte nicht geladen werden: ' + (e?.message || e);
  }
  try {
    const ff = await window.electronAPI.checkFfmpegStatus();
    recFfmpegStatus.classList.remove('ok', 'error');
    if (ff.ok) {
      recFfmpegStatus.classList.add('ok');
      recFfmpegStatus.textContent = `ffmpeg OK — ${ff.version || ff.release || 'Version unbekannt'}`;
    } else {
      recFfmpegStatus.classList.add('error');
      recFfmpegStatus.textContent = `ffmpeg/ffprobe fehlen (${(ff.missing || []).join(', ') || 'unbekannt'}) — Aufnahme nicht verfügbar. App-Start versucht Reparatur.`;
    }
  } catch (e) {
    recFfmpegStatus.classList.remove('ok', 'error');
    recFfmpegStatus.textContent = 'ffmpeg-Status nicht ermittelbar: ' + (e?.message || e);
  }
}

// ── Settings „LiveTV: EPG“: Status des Wochen-Caches im Main (Etappe 1) ──
// Nur Anzeige (textContent) + manueller Refresh; die Daten selbst bleiben im Main.
const settingsEpgCacheStatus = document.getElementById('settingsEpgCacheStatus');
const settingsEpgCacheRefreshBtn = document.getElementById('settingsEpgCacheRefreshBtn');

function describeEpgCacheStatus(status) {
  if (!status || !Array.isArray(status.sources) || !status.sources.some(s => s.fetchedAt)) {
    const err = status?.sources?.find(s => s.lastError)?.lastError;
    return err ? `Noch kein Stand — letzter Fehler: ${err}` : 'Noch kein Stand (wird beim nächsten Refresh geladen)';
  }
  const fmt = ms => new Date(ms).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
  const channels = status.sources.reduce((n, s) => n + (s.channelCount || 0), 0);
  const err = status.sources.find(s => s.lastError);
  return (
    `Stand: ${fmt(status.lastSuccessAt)} · ${channels} Kanäle · reicht ${status.coverageDays} Tage voraus` +
    (status.refreshing ? ' · wird aktualisiert …' : ` · nächster Refresh ca. ${fmt(status.nextRefreshAt)}`) +
    (err ? ` · letzter Fehler: ${err.lastError}` : '')
  );
}

async function loadEpgCacheStatusUi() {
  if (!settingsEpgCacheStatus || !window.electronAPI.getEpgStatus) return;
  try {
    settingsEpgCacheStatus.textContent = describeEpgCacheStatus(await window.electronAPI.getEpgStatus());
  } catch (e) {
    settingsEpgCacheStatus.textContent = 'Status nicht verfügbar: ' + (e?.message || e);
  }
}

if (settingsEpgCacheRefreshBtn) {
  settingsEpgCacheRefreshBtn.addEventListener('click', async () => {
    settingsEpgCacheRefreshBtn.disabled = true;
    settingsEpgCacheStatus.textContent = 'Wird aktualisiert …';
    try {
      settingsEpgCacheStatus.textContent = describeEpgCacheStatus(await window.electronAPI.refreshEpgCache());
    } catch (e) {
      settingsEpgCacheStatus.textContent = 'Aktualisierung fehlgeschlagen: ' + (e?.message || e);
    } finally {
      settingsEpgCacheRefreshBtn.disabled = false;
    }
  });
}

// ── Settings „LiveTV: EPG“: Startansicht des Programmführers (Etappe 3.5, P20) ──
// Die Menge der Werte prüft der Main (lib/ipc-validation.js); hier nur Anzeige und Speichern.
const settingsEpgStartView = document.getElementById('settingsEpgStartView');
const settingsEpgStartViewStatus = document.getElementById('settingsEpgStartViewStatus');

async function loadEpgStartViewUi() {
  if (!settingsEpgStartView || !window.electronAPI.getEpgViewSettings) return;
  try {
    const saved = await window.electronAPI.getEpgViewSettings();
    settingsEpgStartView.value = saved.startView;
    settingsEpgStartViewStatus.textContent = '';
  } catch (e) {
    settingsEpgStartViewStatus.textContent = 'Startansicht nicht verfügbar: ' + (e?.message || e);
  }
}

if (settingsEpgStartView) {
  settingsEpgStartView.addEventListener('change', async () => {
    try {
      const saved = await window.electronAPI.setEpgViewSettings({ startView: settingsEpgStartView.value });
      settingsEpgStartView.value = saved.startView;
      settingsEpgStartViewStatus.textContent = 'Gespeichert. Gilt beim nächsten Öffnen des Programmführers.';
    } catch (e) {
      settingsEpgStartViewStatus.textContent = 'Speichern fehlgeschlagen: ' + (e?.message || e);
      loadEpgStartViewUi();
    }
  });
}

// ── Limits: Parallel-Limit, Höchstdauer, Reserve (Etappe 1) ──
// Validierung/Clamp passiert im Main; die UI zeigt nur die tatsächlich
// gespeicherten Werte und die Reserve-Warnung an.
const recMaxParallelInput = document.getElementById('recMaxParallelInput');
const recMaxDurationInput = document.getElementById('recMaxDurationInput');
const recReserveInput = document.getElementById('recReserveInput');
const recReserveWarn = document.getElementById('recReserveWarn');
const recLimitsSaveBtn = document.getElementById('recLimitsSaveBtn');
const recBufferBeforeInput = document.getElementById('recBufferBeforeInput');
const recBufferAfterInput = document.getElementById('recBufferAfterInput');
const recLateStartInput = document.getElementById('recLateStartInput');

function applyRecordingLimitsToUi(settings) {
  recMaxParallelInput.value = String(settings.maxParallel);
  recMaxDurationInput.value = String(settings.maxDurationHours);
  recReserveInput.value = String(settings.reserveMB);
  recReserveInput.min = String(settings.minReserveMB || 512);
  // Planung (Etappe 2a): Altantworten ohne die Felder zeigen die Defaults
  recBufferBeforeInput.value = String(settings.bufferBeforeMin ?? 2);
  recBufferAfterInput.value = String(settings.bufferAfterMin ?? 5);
  recLateStartInput.checked = settings.lateStart !== false;
  const warn = settings.reserveWarning || '';
  recReserveWarn.textContent = warn ? '⚠ ' + warn : '';
  recReserveWarn.style.display = warn ? '' : 'none';
}

async function loadRecordingLimitsUi() {
  try {
    applyRecordingLimitsToUi(await window.electronAPI.getRecordingSettings());
  } catch (e) {
    setSettingsStatus('✕ Aufnahme-Einstellungen konnten nicht geladen werden: ' + (e?.message || e));
  }
}

async function saveRecordingLimits() {
  recLimitsSaveBtn.disabled = true;
  try {
    // Nur gültige (nicht leere, numerische) Felder senden — ein leeres Feld
    // behält den bisherigen Wert, statt still auf den Default zu fallen.
    const patch = {};
    for (const [key, input] of [
      ['maxParallel', recMaxParallelInput],
      ['maxDurationHours', recMaxDurationInput],
      ['reserveMB', recReserveInput],
      ['bufferBeforeMin', recBufferBeforeInput],
      ['bufferAfterMin', recBufferAfterInput],
    ]) {
      const raw = input.value.trim();
      if (raw !== '' && Number.isFinite(Number(raw))) patch[key] = raw;
    }
    patch.lateStart = recLateStartInput.checked;
    const saved = await window.electronAPI.setRecordingSettings(patch);
    applyRecordingLimitsToUi(saved);
    setSettingsStatus(
      saved.reserveBelowMinimum
        ? `⚠ ${saved.reserveWarning} — ${saved.minReserveMB} MB wurden eingetragen und gespeichert.`
        : '✓ Aufnahme-Einstellungen gespeichert',
    );
  } catch (e) {
    setSettingsStatus('✕ ' + (e?.message || e));
  } finally {
    recLimitsSaveBtn.disabled = false;
  }
}
recLimitsSaveBtn.addEventListener('click', saveRecordingLimits);
// Beim Verlassen des Reserve-Feldes sofort prüfen/speichern: Eingabe unter
// dem Minimum → Warnung + automatisches Setzen und Speichern des Minimums.
recReserveInput.addEventListener('change', saveRecordingLimits);
// Karte „Planung“: speichert sofort (kein eigener Button)
recBufferBeforeInput.addEventListener('change', saveRecordingLimits);
recBufferAfterInput.addEventListener('change', saveRecordingLimits);
recLateStartInput.addEventListener('change', saveRecordingLimits);

// ── Aufwecken für geplante Aufnahmen (macOS, Konzept §4.3) ──
// Status kommt aus dem Main (supported/active/nextWakeMs); nur textContent.
let wakeStatus = null;
let scheduleHasUpcoming = false; // Hinweis in „Geplant“ nur bei vorhandenen Planungen
const recWakeCard = document.getElementById('recWakeCard');
const recWakeStatus = document.getElementById('recWakeStatus');
const recWakeError = document.getElementById('recWakeError');
const recWakeEnableBtn = document.getElementById('recWakeEnableBtn');
const recWakeDisableBtn = document.getElementById('recWakeDisableBtn');

function describeWakeStatus(status) {
  if (!status?.active) return 'Nicht aktiv — der Mac wird für geplante Aufnahmen nicht geweckt.';
  if (status.nextWakeMs) {
    return `Aktiv — nächster Wecktermin: ${new Date(status.nextWakeMs).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`;
  }
  return 'Aktiv — es sind keine Wecktermine nötig (nichts geplant).';
}

function applyWakeStatus(status) {
  wakeStatus = status && typeof status === 'object' ? status : null;
  const supported = !!wakeStatus?.supported;
  recWakeCard.hidden = !supported;
  recWakeStatus.classList.remove('ok', 'error');
  recWakeStatus.classList.add(wakeStatus?.active ? 'ok' : 'error');
  recWakeStatus.textContent = describeWakeStatus(wakeStatus);
  recWakeEnableBtn.hidden = !!wakeStatus?.active;
  recWakeDisableBtn.hidden = !wakeStatus?.active;
  if (currentDashboardGroup === 'recording' && recordingDashboardTab === 'planned' && !scheduleEditingId) {
    refreshWakeHint();
  }
}

async function loadWakeUi() {
  try {
    applyWakeStatus(await window.electronAPI.getWakeStatus());
  } catch (_) {
    applyWakeStatus(null);
  }
}

recWakeEnableBtn.addEventListener('click', async () => {
  recWakeEnableBtn.disabled = true;
  recWakeError.style.display = 'none';
  try {
    const result = await window.electronAPI.enableWake();
    applyWakeStatus(result.status);
    if (!result.ok && !result.cancelled) {
      recWakeError.textContent = '⚠ ' + (result.error || 'Aufwecken konnte nicht aktiviert werden');
      recWakeError.style.display = '';
    }
  } catch (e) {
    recWakeError.textContent = '⚠ ' + (e?.message || e);
    recWakeError.style.display = '';
  } finally {
    recWakeEnableBtn.disabled = false;
  }
});
recWakeDisableBtn.addEventListener('click', async () => {
  recWakeDisableBtn.disabled = true;
  try {
    applyWakeStatus((await window.electronAPI.disableWake()).status);
  } catch (e) {
    recWakeError.textContent = '⚠ ' + (e?.message || e);
    recWakeError.style.display = '';
  } finally {
    recWakeDisableBtn.disabled = false;
  }
});
window.electronAPI.onWakeChanged?.(status => applyWakeStatus(status));

// Hinweis oben in „Geplant“ (nur macOS): Zustand + Link in die Einstellungen
function buildWakeHint() {
  if (!wakeStatus?.supported || !scheduleHasUpcoming) return null;
  const box = document.createElement('div');
  box.className = 'schedule-wake-hint' + (wakeStatus.active ? ' ok' : '');
  box.id = 'scheduleWakeHint';
  if (wakeStatus.active) {
    box.textContent = 'Wecken aktiv: Der Mac wird vor geplanten Aufnahmen aus dem Ruhezustand geweckt, solange Streaming Hub läuft. Ein gesperrter Bildschirm ist unkritisch, die Aufnahme läuft weiter. Bei heruntergefahrenem oder neu gestartetem Mac startet sie nicht.';
    return box;
  }
  box.appendChild(
    document.createTextNode(
      'Ruhezustand: Eine geplante Aufnahme startet nur, wenn in den Einstellungen das Aufwecken erlaubt wurde. Ein gesperrter Bildschirm ist unkritisch, die Aufnahme läuft weiter. Bei heruntergefahrenem oder neu gestartetem Mac startet sie nicht. ',
    ),
  );
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'schedule-wake-link';
  link.id = 'scheduleWakeLink';
  link.textContent = 'Einstellungen öffnen';
  link.addEventListener('click', () => openSettingsPage('livetv-recordings'));
  box.appendChild(link);
  return box;
}

function refreshWakeHint() {
  const list = document.getElementById('scheduleList');
  if (!list) return;
  const old = document.getElementById('scheduleWakeHint');
  if (old) old.remove();
  const hint = buildWakeHint();
  if (hint) list.parentNode.insertBefore(hint, list);
}

async function saveRecordingStorageRoot(newRoot) {
  recPathSaveBtn.disabled = true;
  try {
    const info = await window.electronAPI.setRecordingStorageRoot(newRoot);
    recPathInput.value = info.root;
    recPathHint.textContent = describeStorageRoot(info);
    recPathWarn.style.display = info.network ? '' : 'none';
    recPathWarn.textContent = info.network
      ? '⚠ Netzwerkpfad erkannt: Aufnahmequalität hängt von der Verbindung ab. Bei Verbindungsabbruch versucht die App, den Stream wiederzufinden.'
      : '';
    setSettingsStatus('✓ Speicherort übernommen: ' + info.root);
  } catch (e) {
    setSettingsStatus('✕ ' + (e?.message || e));
  } finally {
    recPathSaveBtn.disabled = false;
  }
}

recPathPickBtn.addEventListener('click', async () => {
  try {
    const picked = await window.electronAPI.pickRecordingFolder();
    if (picked) recPathInput.value = picked;
  } catch (e) {
    setSettingsStatus('✕ ' + (e?.message || e));
  }
});
recPathSaveBtn.addEventListener('click', () => {
  const value = recPathInput.value.trim();
  if (value) saveRecordingStorageRoot(value);
});
// Reset auf den Default-Speicherort: Main kennt den Default (paths.js) —
// das Renderer-UI rät ihn nicht selbst.
recPathResetBtn.addEventListener('click', async () => {
  try {
    const def = await window.electronAPI.getDefaultRecordingRoot();
    if (def) saveRecordingStorageRoot(def);
  } catch (e) {
    setSettingsStatus('✕ ' + (e?.message || e));
  }
});

// ── Settings: Add Service Form ──

const settingsAddDienstBtn = document.getElementById('settingsAddDienstBtn');
const settingsAddForm = document.getElementById('settingsAddForm');
const settingsInputName = document.getElementById('settingsInputName');
const settingsInputUrl = document.getElementById('settingsInputUrl');
const settingsInputIcon = document.getElementById('settingsInputIcon');
const settingsInputColor = document.getElementById('settingsInputColor');
const settingsInputGroup = document.getElementById('settingsInputGroup');
const settingsAddSave = document.getElementById('settingsAddSave');

function toggleSettingsAddForm() {
  const isOpen = settingsAddForm.style.display !== 'none';
  settingsAddForm.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    settingsInputName.value = '';
    settingsInputUrl.value = '';
    settingsInputIcon.value = '';
    settingsInputColor.value = '#6c5ce7';
    settingsInputName.focus();
  }
}
settingsAddDienstBtn.addEventListener('click', toggleSettingsAddForm);
document.getElementById('settingsAddMediathekBtn').addEventListener('click', toggleSettingsAddForm);

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

// ── Fester Ladeweg für Senderliste und EPG-Index ──
// Start (getTvSources), Quellenänderung (refreshTvSourcesAndEpg) und Öffnen des LiveTV-Dashboards.
// Früher lud zusätzlich das Öffnen der linken TV-Sidebar nach (nur wenn der Index fehlte bzw. „unavailable“ war);
// dieser Nachladeweg liegt jetzt hier und läuft nie parallel zu einem laufenden Ladevorgang.
function ensureTvDataLoaded() {
  if (!tvSources.length) return;
  if (tvSourcesRefreshing || tvEpgRefreshing || tvSourceStatus === 'loading' || tvEpgStatus === 'loading') return;
  const needsChannels = tvChannels.length === 0;
  const needsEpg = !settingsEpgIds || tvEpgStatus === 'unavailable';
  if (!needsChannels && !needsEpg) return;
  loadTvChannels().then(() => {
    if (!settingsEpgIds || tvEpgStatus === 'unavailable') return syncEpgFromMain();
    return null;
  });
}

function renderTvStatus() {
  let statusText = 'Keine Quellen';
  if (tvSources.length) {
    if (tvSourcesRefreshing || tvSourceStatus === 'loading') {
      statusText = 'Quellen werden aktualisiert…';
    } else if (tvEpgRefreshing || tvEpgStatus === 'loading') {
      statusText = 'EPG wird aktualisiert…';
    } else {
      const sourceText = tvSourceErrors.length
        ? `${tvSources.length - tvSourceErrors.length}/${tvSources.length} Quellen geladen`
        : `${tvChannels.length} Sender geladen`;
      if (tvEpgStatus === 'unavailable') statusText = sourceText + ' · Keine EPG-URL';
      else if (tvEpgErrors.length) statusText = sourceText + ` · EPG: ${tvEpgErrors.length} Fehler`;
      else if (settingsEpgIds) statusText = sourceText + ` · EPG: ${settingsEpgIds.size} Kanäle`;
      else statusText = sourceText;
    }
  }
  dashboardTvStatus.textContent = statusText;
  dashboardTvStatus.title = statusText;
  if (settingsTvSourcesView) settingsTvSourcesView.updateEpgInfo();
}

async function loadTvChannels(forceReload) {
  if (!forceReload && tvChannels.length > 0) {
    renderTvChannels();
    renderTvStatus();
    return { failedSources: [] };
  }
  if (!tvSources.length) {
    tvOriginalChannelUrls = {};
    tvChannels = [];
    tvSourceErrors = [];
    tvSourceStatus = 'success';
    renderTvStatus();
    return { failedSources: [] };
  }

  tvSourceStatus = 'loading';
  tvSourceErrors = [];
  renderTvStatus();
  const sourceChannelMap = {};
  const sourceChannelOriginalUrlMap = {};
  const results = await Promise.all(
    tvSources.map(async source => {
      try {
        const result = await window.electronAPI.fetchAndParseM3U(source.url);
        // Der Main-Prozess meldet Ladefehler als { error } (kein geworfener IPC-Fehler).
        if (result.error) throw new Error(result.error);
        const tagged = result.channels.map(ch => ({ ...ch, sourceId: source.id }));
        sourceChannelMap[source.id] = tagged;
        sourceChannelOriginalUrlMap[source.id] = Object.fromEntries(result.channels.map(ch => [ch.id, ch.url]));
        source.baseUrl = result.baseUrl || '';
        return { source, ok: true };
      } catch (err) {
        logger.warn('Fehler beim Laden von', source.name, err.message);
        sourceChannelMap[source.id] = [];
        return { source, ok: false, error: err };
      }
    }),
  );

  tvSourceErrors = results.filter(result => !result.ok).map(result => result.source.name);
  tvOriginalChannelUrls = sourceChannelOriginalUrlMap;
  tvChannels = [];
  tvSources.forEach(source => {
    let srcChannels = applyChannelOverrides(sourceChannelMap[source.id] || [], source);
    if (source.sortOrder && source.sortOrder.length) srcChannels = applySortOrder(srcChannels, source.sortOrder);
    tvChannels = tvChannels.concat(srcChannels);
  });
  tvSourceStatus = tvSourceErrors.length === tvSources.length ? 'error' : 'success';
  renderTvChannels();
  renderTvStatus();
  return { failedSources: tvSourceErrors };
}

// ── EPG-Datenweg: Main hält den Cache (EpgService); der Renderer fragt nur Ausschnitte ab ──

/** Jetzt/Nächste für die Kanäle (Default: alle) frisch aus dem Main in den Cache laden. */
async function reloadEpgNowNext(channels = tvChannels) {
  const keys = [...new Set(channels.map(ch => epgAdapter.channelEpgKey(ch)).filter(Boolean))];
  if (!keys.length) return;
  try {
    const parts = await Promise.all(
      epgAdapter.chunk(keys, epgAdapter.NOW_NEXT_CHUNK).map(part => window.electronAPI.getEpgNowNext(part)),
    );
    const fresh = epgAdapter.nowNextToMap(parts.flat());
    if (channels === tvChannels) epgNowNextCache = fresh;
    else fresh.forEach((value, key) => epgNowNextCache.set(key, value));
  } catch (err) {
    logger.warn('Jetzt/Nächste nicht verfügbar:', err.message);
  }
}

async function reloadSettingsEpgList() {
  try {
    settingsEpgList = (await window.electronAPI.getEpgChannels()) || [];
  } catch (err) {
    logger.warn('EPG-Kanalliste nicht verfügbar:', err.message);
    settingsEpgList = [];
  }
  settingsEpgIds = settingsEpgList.length ? new Set(settingsEpgList.map(entry => entry.normId)) : null;
}

let epgSyncRunning = false;
let epgSyncAgain = false;
let epgSyncForceAgain = false;

/**
 * Stand des Main-EPG in den Renderer übernehmen (Status, Kanalliste, Jetzt/Nächste) und die Anzeigen auffrischen.
 * forceRefresh: Main lädt die Quellen neu (epg:refresh), sonst nur der vorhandene Cache. Läuft nie parallel
 * (ein Nachlauf, falls währenddessen epg:changed kam).
 */
async function syncEpgFromMain({ forceRefresh = false } = {}) {
  if (epgSyncRunning) {
    epgSyncAgain = true;
    if (forceRefresh) epgSyncForceAgain = true;
    return;
  }
  epgSyncRunning = true;
  try {
    do {
      epgSyncAgain = false;
      await syncEpgFromMainOnce(forceRefresh);
      forceRefresh = epgSyncForceAgain;
      epgSyncForceAgain = false;
    } while (epgSyncAgain);
  } finally {
    epgSyncRunning = false;
  }
}

async function syncEpgFromMainOnce(forceRefresh) {
  if (!tvSources.some(source => source.epgUrl)) {
    epgNowNextCache = new Map();
    settingsEpgList = [];
    settingsEpgIds = null;
    tvEpgErrors = [];
    tvEpgStatus = 'unavailable';
    renderTvStatus();
    return;
  }
  tvEpgStatus = 'loading';
  tvEpgErrors = [];
  renderTvStatus();
  let status = null;
  try {
    status = forceRefresh ? await window.electronAPI.refreshEpgCache() : await window.electronAPI.getEpgStatus();
  } catch (err) {
    logger.warn('EPG-Status nicht verfügbar:', err.message);
  }
  const sources = status && Array.isArray(status.sources) ? status.sources.filter(src => src.configured) : [];
  tvEpgErrors = sources.filter(src => src.lastError).map(src => src.url);
  await Promise.all([reloadSettingsEpgList(), reloadEpgNowNext()]);
  const hasData = Boolean(settingsEpgIds);
  if (hasData) tvEpgStatus = 'success';
  else if (tvEpgErrors.length || !status) tvEpgStatus = 'error';
  else tvEpgStatus = status.refreshing ? 'loading' : 'idle';
  tvEpgLoadedAt = status && status.lastSuccessAt ? new Date(status.lastSuccessAt) : null;
  renderTvChannels();
  renderTvStatus();
  if (currentDashboardGroup === 'livetv' && !currentProvider) renderDashboard('livetv');
}

// Main meldet einen neuen Cache-Stand (Refresh, Quellenänderung): Anzeigen auffrischen
window.electronAPI.onEpgChanged(() => {
  syncEpgFromMain();
});

// Laufende Sendungen laufen ab: Cache jede Minute nachziehen (ohne Neuaufbau der Anzeigen)
setInterval(() => {
  if (settingsEpgIds) reloadEpgNowNext();
}, 60 * 1000);

async function refreshTvSourcesAndEpg() {
  if (tvSourcesRefreshing) return;
  tvSourcesRefreshing = true;
  tvEpgRefreshing = true;
  renderTvStatus();
  try {
    await loadTvChannels(true);
    await syncEpgFromMain({ forceRefresh: true });
  } finally {
    tvSourcesRefreshing = false;
    tvEpgRefreshing = false;
    renderTvStatus();
  }
}

function updateEpgStatus() {
  renderTvStatus();
}

async function refreshEpg() {
  if (tvEpgRefreshing || tvSourcesRefreshing) return;
  tvEpgRefreshing = true;
  try {
    await syncEpgFromMain({ forceRefresh: true });
  } finally {
    tvEpgRefreshing = false;
    renderTvStatus();
  }
}

// Die frühere „Alle Sender“-Liste (Overlay) ist entfernt; übrig bleibt das Auffrischen der Senderverwaltung in den Einstellungen.
function renderTvChannels() {
  if (settingsTvChannelsView) settingsTvChannelsView.render();
}

// ── TV Channel Editor: Senderverwaltung liegt in settings-tv-channels.js ──
let tvOriginalChannelUrls = {}; // {sourceId: {channelId: Original-URL}} für die Sender-Seite

async function selectTvChannel(ch, options = {}) {
  if (!restoringNav) pushNavState();
  disposeDashboardPlayback();
  tvActiveChannelId = ch.id;
  overlayBar.classList.add('nav-collapsed');
  overlayBar.classList.remove('is-fullscreen');
  placeUpdateButton(overlayUpdateSlot);
  renderTvChannels();

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
  if (dashboardView) dashboardView.style.display = 'none';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  // Jetzt/Nächste des Kanals frisch aus dem Main holen (Cache kann bis zu einer Minute alt sein)
  await reloadEpgNowNext([ch]);
  const { epgTitle, epgStart, epgEnd, epgNext } = buildEpgContextForChannel(ch);

  // Load tv.html with channel URL as parameter (needs file:// protocol)
  const isTvPage = tvView.getURL() && tvView.getURL().includes('tv.html');
  if (isTvPage && tvViewReady) {
    try {
      const msg = {
        type: 'switch-channel',
        url: ch.url,
        name: ch.name,
        logo: ch.logo || '',
        channelId: ch.id,
        epg: epgTitle,
        epgStart: epgStart,
        epgEnd: epgEnd,
        epgNext: epgNext,
        dvr: dvrBarMode(),
      };
      if (!options.suppressChannelList) {
        const channelList = buildChannelList(ch, tvChannels, tvSources);
        const enrichedChannels = (channelList.channels || []).map(c => {
          const fullCh = tvChannels.find(tc => tc.id === c.id);
          const { current } = epgAdapter.resolveNowNext(
            epgNowNextCache.get(epgAdapter.channelEpgKey(fullCh || c)),
            Date.now(),
          );
          return { ...c, epg: current ? current.title : '' };
        });
        msg.channelList = enrichedChannels;
        msg.channelIndex = channelList.currentIndex;
      }
      tvView.send('tv-player-command', msg);
      // U2: EPG-Rohdaten sofort hinterher schieben, damit die DVR-Marker nicht
      // auf den ersten 30s-Poll warten müssen.
      pushEpgToTvView();
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
      encodeURIComponent(epgNext) +
      // A-Fail R2-FB-01 (t_d6ee955e): channelId als URL-Param mitschicken.
      // tv.html liest ihn beim Initial-Load in setupChannel → recChannelCtx;
      // ohne ihn bleibt der kanalgebundene Record-Button weiß trotz laufender
      // Aufnahme auf diesem Kanal (Start-Dialog statt Stop-Flow).
      '&channelId=' +
      encodeURIComponent(ch.id) +
      '&hls=' +
      encodeURIComponent('file://' + appPath + '/node_modules/hls.js/dist/hls.min.js');
    if (tvViewReady) {
      try {
        tvView.loadURL(playerUrl).catch(error => {
          logger.warn('loadURL failed:', error);
        });
      } catch (e) {
        logger.warn('loadURL failed:', e);
      }
    } else {
      pendingNav = playerUrl;
    }
  }
}

function switchTvChannel(dir) {
  if (!tvActiveChannelId) return;
  const nextId = getNextChannelId(tvActiveChannelId, tvChannels, tvSources, dir);
  if (!nextId) return;
  const nextCh = tvChannels.find(c => c.id === nextId);
  if (nextCh) selectTvChannel(nextCh);
}

// ── EPG-Programmführer (Etappe 3.3): epg-view.js liest ausschließlich den Main-Cache ──
// Planen, Stoppen, Sender öffnen usw. bleiben hier (eine Planungs-Logik, kein Duplikat).

const epgView = createEpgView(epgOverlay, {
  api: window.electronAPI,
  getChannels: () => tvChannels,
  getSources: () => tvSources.map(source => ({ id: source.id, name: source.name })),
  getStartView: () => window.electronAPI.getEpgViewSettings().then(saved => saved && saved.startView),
  isFavorite: ch => isFavorite(ch, tvSources),
  sanitizeLogoUrl: url => safeResourceUrl(url),
  recordProgramme: programme => handleEpgRecordClick(programme),
  stopRecording: recId => stopRecordingById(recId),
  openChannel: channel => {
    const ch = tvChannels.find(c => c.id === channel.id);
    if (!ch) return;
    selectTvChannel(ch, { suppressChannelList: true });
  },
  getMediathek: (channel, title) => {
    const mediathek = getMediathekForChannel(channel.tvgId || channel.name);
    if (!mediathek) return null;
    const svc = services.find(s => s.id === mediathek.serviceId);
    return {
      label: `In ${svc ? svc.name : 'Mediathek'} ansehen`,
      open: () => {
        if (svc) navigateTo({ ...svc, url: mediathek.searchUrl + encodeURIComponent(title) });
      },
    };
  },
  showPlanned: () => {
    recordingDashboardTab = 'planned';
    scheduleEditingId = null;
    showDashboard('recording');
  },
  onOpenChange: handleEpgOpenChange,
  onError: err => logger.warn('EPG-Programmführer:', err?.message || err),
});
epgViewReady = true;

// Navbar über dem Programmführer: Das Overlay (z-index 100) deckt die Navbar sonst samt ihrer Hover-Zone ab.
// Solange es offen ist, steht die Navbar eingeklappt darüber (body.epg-open hebt sie über das Overlay) und
// blendet sich per Hover wie in jeder Ansicht ein; beim Schließen kommt der vorherige Zustand zurück.
let epgBarSaved = null;
function handleEpgOpenChange(open) {
  document.body.classList.toggle('epg-open', open);
  if (open) {
    epgBarSaved = { always: overlayBar.classList.contains('always-visible'), collapsed: overlayBar.classList.contains('nav-collapsed') };
    overlayBar.classList.remove('always-visible');
    overlayBar.classList.add('nav-collapsed');
  } else if (epgBarSaved) {
    overlayBar.classList.toggle('always-visible', epgBarSaved.always);
    overlayBar.classList.toggle('nav-collapsed', epgBarSaved.collapsed);
    epgBarSaved = null;
  }
}

/** Jede Navigation aus der Navbar beendet den Programmführer zuerst (er läge sonst über dem Ziel). */
function closeEpgForNavigation() {
  if (epgViewReady && epgView.isOpen()) epgView.close();
}

function openEpgView() {
  epgView.open();
}

// ── Planung: „Aufnehmen“ im EPG-Detail + Planungsdialog (Etappe 2a, §3.7) ──
// Alle Texte (Titel, Sender, Beschreibung) laufen ausschließlich über textContent.

function handleEpgRecordClick(programme) {
  // Zukunftsregel unverändert: laufend/vorbei → Meldung, kein Dialog. Die Texte sind die dekodierten
  // Main-EPG-Texte (Parser im Main dekodiert einmal) — hier nicht noch einmal dekodieren.
  const verdict = scheduleUi.classifyProgramme(programme.startMs, programme.stopMs, Date.now());
  if (verdict.state !== 'future') {
    epgView.notify(verdict.message);
    return;
  }
  epgView.notify('');
  const ch = tvChannels.find(c => c.id === programme.channelId) || null;
  openSchedulePlanningDialog({
    title: programme.title || '',
    description: programme.description || '',
    channelName: programme.channel || ch?.name || '',
    channelId: programme.channelId || ch?.id || '',
    tvgId: programme.tvgId || ch?.tvgId || '',
    sourceId: ch?.sourceId || '',
    sourceUrl: ch?.url || '',
    startMs: programme.startMs,
    stopMs: programme.stopMs,
  });
}

let recSchedulePending = null; // { close } des gerade offenen Dialogs

function openSchedulePlanningDialog(ctx) {
  if (recSchedulePending) return;
  const overlay = document.getElementById('recScheduleOverlay');
  const progEl = document.getElementById('recScheduleProg');
  const whenEl = document.getElementById('recScheduleWhen');
  const beforeInput = document.getElementById('recScheduleBefore');
  const afterInput = document.getElementById('recScheduleAfter');
  const adjEl = document.getElementById('recScheduleAdjacency');
  const conflictEl = document.getElementById('recScheduleConflict');
  const errorEl = document.getElementById('recScheduleError');
  const discardBtn = document.getElementById('recScheduleDiscard');
  const mergeBtn = document.getElementById('recScheduleMerge');
  const confirmBtn = document.getElementById('recScheduleConfirm');
  if (!overlay || !progEl || !confirmBtn || !window.electronAPI.addSchedule) return;

  progEl.textContent = `${ctx.title} — ${ctx.channelName}`;
  whenEl.textContent = scheduleUi.formatSlotRange(ctx.startMs, ctx.stopMs);
  const previousFocus = document.activeElement;
  let state = { conflict: null, adjacency: null, planable: false, busy: false };
  let checkTimer = null;
  let checkSeq = 0;

  const toSec = input => {
    const raw = input.value.trim();
    if (raw === '' || !Number.isFinite(Number(raw))) return undefined;
    return Math.round(Math.min(30, Math.max(0, Number(raw))) * 60);
  };
  const buildRequest = extra => {
    const request = {
      channelId: ctx.channelId,
      channelName: ctx.channelName,
      tvgId: ctx.tvgId,
      sourceId: ctx.sourceId,
      title: scheduleUi.clampText(ctx.title, 300),
      description: scheduleUi.clampText(ctx.description, 2000),
      epgStart: scheduleUi.toScheduleIso(ctx.startMs),
      epgStop: scheduleUi.toScheduleIso(ctx.stopMs),
      ...extra,
    };
    if (/^https?:\/\//i.test(ctx.sourceUrl)) request.sourceUrlSnapshot = ctx.sourceUrl;
    const before = toSec(beforeInput);
    const after = toSec(afterInput);
    if (before !== undefined) request.bufferBeforeSec = before;
    if (after !== undefined) request.bufferAfterSec = after;
    return request;
  };
  const showError = message => {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  };
  const render = () => {
    const conflictText = scheduleUi.describeConflict(state.conflict);
    conflictEl.textContent = conflictText;
    conflictEl.hidden = !conflictText;
    const adjText = scheduleUi.describeAdjacency(state.adjacency);
    adjEl.textContent = adjText;
    adjEl.hidden = !adjText;
    mergeBtn.hidden = !(state.adjacency && state.adjacency.canMerge);
    confirmBtn.textContent = state.conflict && state.conflict.exceeds ? 'Trotzdem planen' : 'Planen';
    confirmBtn.disabled = !state.planable || state.busy;
    mergeBtn.disabled = !state.planable || state.busy;
  };

  const runCheck = async () => {
    const seq = (checkSeq += 1);
    try {
      // Plausibilisierung gegen den Main-EPG-Cache (Datenquelle der Planung)
      const key = ctx.tvgId || ctx.channelId;
      const slot = key && window.electronAPI.findEpg ? await window.electronAPI.findEpg(key, ctx.startMs) : null;
      if (seq !== checkSeq) return;
      if (!slot) {
        state = { conflict: null, adjacency: null, planable: false, busy: false };
        showError(scheduleUi.MSG_NO_EPG);
        render();
        return;
      }
      const res = await window.electronAPI.checkScheduleConflicts(buildRequest({}));
      if (seq !== checkSeq) return;
      state = { conflict: res.conflict, adjacency: res.adjacency, planable: true, busy: false };
      showError('');
    } catch (e) {
      if (seq !== checkSeq) return;
      state = { conflict: null, adjacency: null, planable: false, busy: false };
      showError(scheduleUi.ipcErrorMessage(e));
    }
    render();
  };
  const scheduleCheck = () => {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(runCheck, 250);
  };

  const close = () => {
    clearTimeout(checkTimer);
    checkSeq += 1;
    overlay.classList.remove('open');
    confirmBtn.removeEventListener('click', onConfirm);
    mergeBtn.removeEventListener('click', onMerge);
    discardBtn.removeEventListener('click', close);
    beforeInput.removeEventListener('input', scheduleCheck);
    afterInput.removeEventListener('input', scheduleCheck);
    overlay.removeEventListener('keydown', onKey);
    recSchedulePending = null;
    if (previousFocus && typeof previousFocus.focus === 'function') {
      try { previousFocus.focus(); } catch (_e) { /* Element weg */ }
    }
  };

  const submit = async extra => {
    if (state.busy || !state.planable) return;
    state = { ...state, busy: true };
    render();
    try {
      const result = await window.electronAPI.addSchedule(buildRequest(extra));
      if (result && result.ok === false && result.code === 'CONFLICT') {
        // Zwischenzeitlich neuer Konflikt: Warnung zeigen, Entscheidung bleibt beim Nutzer
        state = { conflict: result.conflict, adjacency: result.adjacency, planable: true, busy: false };
        render();
        return;
      }
      close();
      const when = scheduleUi.formatSlotRange(ctx.startMs, ctx.stopMs);
      epgView.notify(
        result && result.merged
          ? `Aufnahme verlängert: ${result.entry.title} (${scheduleUi.formatEntryTimes(result.entry)})`
          : `Aufnahme geplant: ${ctx.title} (${when})`,
        true,
      );
    } catch (e) {
      state = { ...state, busy: false };
      showError(scheduleUi.ipcErrorMessage(e));
      render();
    }
  };
  const onConfirm = () => submit(state.conflict && state.conflict.exceeds ? { allowOverLimit: true } : {});
  const onMerge = () =>
    submit({ mergeWithId: state.adjacency.entryId, ...(state.conflict && state.conflict.exceeds ? { allowOverLimit: true } : {}) });

  // Esc = Verwerfen; Tab bleibt im Dialog (Fokus-Trap über die sichtbaren Bedienelemente)
  const onKey = ev => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
    } else if (ev.key === 'Tab') {
      const order = [beforeInput, afterInput, discardBtn, mergeBtn, confirmBtn].filter(el => !el.hidden && !el.disabled);
      if (!order.length) return;
      const idx = order.indexOf(document.activeElement);
      const next = ev.shiftKey ? (idx <= 0 ? order.length - 1 : idx - 1) : idx === -1 || idx === order.length - 1 ? 0 : idx + 1;
      ev.preventDefault();
      order[next].focus();
    }
  };

  confirmBtn.addEventListener('click', onConfirm);
  mergeBtn.addEventListener('click', onMerge);
  discardBtn.addEventListener('click', close);
  beforeInput.addEventListener('input', scheduleCheck);
  afterInput.addEventListener('input', scheduleCheck);
  overlay.addEventListener('keydown', onKey);
  recSchedulePending = { close };

  showError('');
  state = { conflict: null, adjacency: null, planable: false, busy: false };
  render();
  overlay.classList.add('open');
  discardBtn.focus();
  // Puffer-Defaults aus den Settings, dann erste Prüfung
  window.electronAPI
    .getRecordingSettings()
    .then(settings => {
      beforeInput.value = String(settings.bufferBeforeMin ?? 2);
      afterInput.value = String(settings.bufferAfterMin ?? 5);
    })
    .catch(() => {
      beforeInput.value = '2';
      afterInput.value = '5';
    })
    .finally(runCheck);
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
        // Verlaufseintrag „TV“: zurück ins LiveTV-Dashboard (Sendersuche/Favoriten), keine Seitenleiste mehr
        showDashboard('livetv');
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

// ═══ Aufnahmen-Bibliothek (Phase 1c, Konzept §3.3) ═══
// Neuer Screen „Aufnahmen“ (Muster: History-Overlay). Einträge mit Kanal-Logo,
// Titel, Kanal, Datum/Uhrzeit, Dauer, Status, Wiedergabe, Löschen.
// Bewusst KEINE Dateigröße (Konzept-Beschluss). Status-Spalte:
// „Konvertiere… N % · noch ~Xs“ (Remux-Progress), „Laufende Aufnahme“
// (live über die HLS-Zwischenform abspielbar), „Fertig“, „Fehlgeschlagen“.
// Fix-Set 4 (User-Ergänzung): recordings-Overlay entfernt — die alten
// Overlay-Konstanten existieren nicht mehr; die Bibliothek rendert in den
// Dashboard-Bereich (renderRecordingsInto).
const recordingPlayer = document.getElementById('recordingPlayer');
const recordingPlayerVideo = document.getElementById('recordingPlayerVideo');
const recordingPlayerClose = document.getElementById('recordingPlayerClose');
const recordingPlayerError = document.getElementById('recordingPlayerError');

let recordingPlaybackUrl = null; // für native-<video>-Fallback (MP4)

// Fix-Set 4 (Karte t_18d3dbb2): Media-Loader-/Dekode-Fehler einer Aufnahme
// waren unsichtbar — der Chromium-Media-Stack bricht bei korruptem
// h264-Elementarstream still ab (User-Symptom: Wiedergabe zeigt ~1 s und
// stockt, Seek zeigt dasselbe Frame, keine Meldung). Dem Media-Element
// liegt hier ein fertiger Container zugrunde; Decode-Fehler einzelner
// Frames lösen KEIN 'error'-Event aus (nur Ladepfad-Fehler tun das),
// deshalb zusätzlich decoding-monitor auf 'decoding-error'.
const MEDIA_ERROR_CODE_TEXTS = {
  1: 'Wiedergabe abgebrochen (Ladevorgang unterbrochen).',
  2: 'Wiedergabe abgebrochen (Netzwerkfehler).',
  3: 'Wiedergabe abgebrochen (Dekodierung nicht möglich).',
  4: 'Die Aufnahme ist nicht lesbar — der Video-Stream dieser Datei wird als beschädigt gemeldet.',
};

function hideRecordingPlayerError() {
  if (recordingPlayerError) {
    recordingPlayerError.hidden = true;
    recordingPlayerError.textContent = '';
  }
}

function showRecordingPlayerError(message) {
  logger.warn('[recording playback] ' + message);
  if (!recordingPlayerError) {
    showTvToast(message);
    return;
  }
  recordingPlayerError.textContent = message;
  recordingPlayerError.hidden = false;
  showTvToast(message);
}

function recordingStatusText(meta) {
  if (meta.status === 'recording') return 'Laufende Aufnahme';
  if (meta.status === 'remux-pending') {
    if (meta.remuxDeferredReason && !remuxProgressMap.has(meta.id)) return meta.remuxDeferredReason;
    const p = remuxProgressMap.get(meta.id);
    if (p && typeof p.percent === 'number') {
      const rest = Number.isFinite(p.remainingSec) ? ` · noch ~${formatDuration(p.remainingSec)}` : '';
      return `Konvertiere… ${Math.round(p.percent)} %${rest}`;
    }
    return 'Konvertiere…';
  }
  if (meta.status === 'completed') {
    if (meta.stopReason === 'disk-full') return 'Fertig — beendet: Speicher voll';
    if (meta.stopReason === 'max-duration') return 'Fertig — beendet: Höchstdauer erreicht';
    if (meta.stopReason === 'storage-lost') return 'Fertig — beendet: Speicherort nicht erreichbar';
    return 'Fertig';
  }
  if (meta.status === 'aborted') return 'Abgebrochen';
  return 'Fehlgeschlagen';
}

function recordingChannelLogo(chName) {
  const ch = tvChannels.find(c => (c.name || '') === chName);
  return ch && ch.logo ? safeResourceUrl(ch.logo, { allowRelative: false }) : '';
}

function formatRecordingDate(meta) {
  const start = meta.startedAt ? new Date(meta.startedAt) : null;
  if (!start || Number.isNaN(start.getTime())) return '';
  return start.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' · ' + start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function recordingDurationText(meta) {
  if (meta.status === 'recording') {
    const started = meta.startedAt ? new Date(meta.startedAt).getTime() : null;
    const sec = started ? Math.max(0, (Date.now() - started) / 1000) : 0;
    return formatDuration(sec);
  }
  return Number.isFinite(meta.durationSec) && meta.durationSec ? formatDuration(meta.durationSec) : '—';
}

function renderRecordingsInto(listEl) {
  const recordingsList = listEl;
  window.electronAPI.listRecordings().then(entries => {
    recordingsList.innerHTML = '';
    if (!entries || !entries.length) {
      recordingsList.innerHTML = '<div class="recordings-empty">Noch keine Aufnahmen.</div>';
      return;
    }
    // Neuere zuerst (Index-Reihenfolge), active recordings oben halten:
    const sorted = [...entries].sort((a, b) => {
      if (a.status === 'recording' && b.status !== 'recording') return -1;
      if (b.status === 'recording' && a.status !== 'recording') return 1;
      return 0;
    });
    for (const meta of sorted) {
      const row = document.createElement('div');
      row.className = 'recording-entry';

      const logoSrc = recordingChannelLogo(meta.channelName);
      const logo = logoSrc
        ? Object.assign(document.createElement('img'), { className: 'recording-entry-logo', alt: '' })
        : Object.assign(document.createElement('div'), {
            className: 'recording-entry-logo-fallback',
            textContent: (meta.channelName || '?').slice(0, 1).toUpperCase(),
          });
      if (logoSrc) logo.src = logoSrc;
      row.appendChild(logo);

      const body = document.createElement('div');
      body.className = 'recording-entry-body';
      const title = meta.epgTitle || 'Aufnahme';
      const durationText = recordingDurationText(meta);
      body.innerHTML =
        `<div class="recording-entry-title">${escapeHtml(title)}</div>` +
        `<div class="recording-entry-meta">${escapeHtml(meta.channelName || 'Unbekannter Kanal')} · ` +
        `${escapeHtml(formatRecordingDate(meta))} · ${escapeHtml(durationText)}</div>` +
        `<div class="recording-entry-status ${escapeHtml(meta.status)}">${escapeHtml(recordingStatusText(meta))}</div>`;
      row.appendChild(body);

      const actions = document.createElement('div');
      actions.className = 'recording-entry-actions';

      const playBtn = document.createElement('button');
      playBtn.className = 'recording-entry-btn';
      playBtn.textContent = '▶ Wiedergabe';
      // Zurückgestellter Remux („Speicher knapp“): HLS-Zwischenform bleibt abspielbar
      const playable =
        meta.status === 'completed' ||
        meta.status === 'recording' ||
        (meta.status === 'remux-pending' && !!meta.remuxDeferredReason);
      playBtn.disabled = !playable;
      if (playable) playBtn.addEventListener('click', () => openRecordingPlayback(meta));
      actions.appendChild(playBtn);

      const stopBtn = document.createElement('button');
      stopBtn.className = 'recording-entry-btn';
      stopBtn.textContent = '⏹ Stoppen';
      stopBtn.style.display = meta.status === 'recording' ? '' : 'none';
      if (meta.status === 'recording') {
        stopBtn.addEventListener('click', () => {
          stopRecordingById(meta.id).catch(err =>
            showTvToast('Aufnahme konnte nicht gestoppt werden: ' + (err?.message || err)));
        });
      }
      actions.appendChild(stopBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'recording-entry-btn danger';
      delBtn.textContent = 'Löschen';
      delBtn.disabled = meta.status === 'recording';
      if (meta.status !== 'recording') {
        delBtn.addEventListener('click', async () => {
          delBtn.disabled = true;
          try {
            await window.electronAPI.deleteRecording(meta.id);
            renderRecordingDashboard();
          } catch (err) {
            showTvToast('Löschen fehlgeschlagen: ' + (err?.message || err));
            delBtn.disabled = false;
          }
        });
      }
      actions.appendChild(delBtn);

      row.appendChild(actions);
      recordingsList.appendChild(row);
    }
  }).catch(e => {
    recordingsList.innerHTML = `<div class="recordings-empty">Aufnahmen konnten nicht geladen werden: ${escapeHtml(e?.message || String(e))}</div>`;
  });
}

// Fix-Set 4 (User-Ergänzung 01.10):
// Bibliothekseinstieg läuft über die Karte „Aufnahmen“ im LiveTV-Dashboard, Strg+R und das Tray-Menü;
// das alte recordings-Overlay ist entfernt.
function openRecordingsScreen() {
  showDashboard('recording');
}

// Dashboard „Aufnahmen“: Tabs „Bibliothek“ | „Geplant“ (Etappe 2a, §3.7)
let recordingDashboardTab = 'library';
let scheduleEditingId = null; // Eintrag mit offener Puffer-Bearbeitung (kein Überzeichnen)

function renderRecordingDashboard() {
  const panel = document.createElement('div');
  panel.className = 'recordings-dashboard-panel';
  const header = document.createElement('div');
  header.className = 'recordings-dashboard-header';
  const titleEl = document.createElement('span');
  titleEl.className = 'recordings-dashboard-title';
  titleEl.textContent = 'Aufnahmen';
  header.appendChild(titleEl);
  const refresh = document.createElement('button');
  refresh.className = 'recordings-refresh';
  refresh.id = 'recordingsRefresh';
  refresh.title = 'Aktualisieren';
  refresh.textContent = '↻';
  refresh.addEventListener('click', () => {
    scheduleEditingId = null;
    renderRecordingDashboard();
  });
  header.appendChild(refresh);
  panel.appendChild(header);

  const tabs = document.createElement('div');
  tabs.className = 'recordings-tabs';
  tabs.setAttribute('role', 'tablist');
  for (const [key, label] of [['library', 'Bibliothek'], ['planned', 'Geplant']]) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = `recordingsTab-${key}`;
    tab.className = 'recordings-tab' + (recordingDashboardTab === key ? ' active' : '');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', recordingDashboardTab === key ? 'true' : 'false');
    tab.textContent = label;
    tab.addEventListener('click', () => {
      if (recordingDashboardTab === key) return;
      recordingDashboardTab = key;
      scheduleEditingId = null;
      renderRecordingDashboard();
    });
    tabs.appendChild(tab);
  }
  panel.appendChild(tabs);

  const list = document.createElement('div');
  list.className = 'recordings-list recordings-dashboard-list';
  list.id = recordingDashboardTab === 'planned' ? 'scheduleList' : 'recordingsLibraryList';
  panel.appendChild(list);
  if (recordingDashboardTab === 'planned') {
    renderScheduleInto(list);
    // Hinweis aus dem letzten Stand sofort, danach frisch aus dem Main (auch nach App-Neustart)
    refreshWakeHint();
    window.electronAPI.getWakeStatus?.().then(applyWakeStatus).catch(() => {});
  } else renderRecordingsInto(list);
  dashboardGrid.innerHTML = '';
  dashboardGrid.appendChild(panel);
}

// ── Planungsliste „Geplant“ ──
// Nur textContent: Titel/Sender stammen aus dem EPG (fremder Text).

function scheduleRowButton(label, onClick, { danger = false } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'recording-entry-btn' + (danger ? ' danger' : '');
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function buildScheduleRow(entry) {
  const row = document.createElement('div');
  row.className = 'recording-entry';
  row.dataset.scheduleId = entry.id;
  row.dataset.state = entry.state;

  const logoSrc = recordingChannelLogo(entry.channelName);
  const logo = logoSrc
    ? Object.assign(document.createElement('img'), { className: 'recording-entry-logo', alt: '' })
    : Object.assign(document.createElement('div'), {
        className: 'recording-entry-logo-fallback',
        textContent: (entry.channelName || '?').slice(0, 1).toUpperCase(),
      });
  if (logoSrc) logo.src = logoSrc;
  row.appendChild(logo);

  const body = document.createElement('div');
  body.className = 'recording-entry-body';
  const title = document.createElement('div');
  title.className = 'recording-entry-title';
  title.textContent = entry.title;
  const meta = document.createElement('div');
  meta.className = 'recording-entry-meta';
  meta.textContent = `${entry.channelName || entry.channelId} · ${scheduleUi.formatEntryTimes(entry)} · ${scheduleUi.formatBuffers(entry)}`;
  const status = document.createElement('div');
  status.className = `recording-entry-status schedule-status s-${entry.state}`;
  status.textContent = scheduleUi.scheduleStatusText(entry);
  body.append(title, meta, status);
  row.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'recording-entry-actions';
  if (entry.state === 'scheduled') {
    actions.appendChild(scheduleRowButton('Bearbeiten', () => {
      scheduleEditingId = entry.id;
      renderRecordingDashboard();
    }));
    actions.appendChild(scheduleRowButton('Absagen', ev => cancelScheduleEntry(entry, ev.currentTarget), { danger: true }));
  } else if (entry.state !== 'recording') {
    actions.appendChild(scheduleRowButton('Entfernen', ev => removeScheduleEntry(entry, ev.currentTarget)));
  }
  row.appendChild(actions);

  if (scheduleEditingId === entry.id && entry.state === 'scheduled') body.appendChild(buildScheduleEditForm(entry));
  return row;
}

function buildScheduleEditForm(entry) {
  const form = document.createElement('div');
  form.className = 'schedule-inline-edit';
  const mkInput = (label, sec) => {
    const wrap = document.createElement('label');
    wrap.textContent = label + ' ';
    const input = document.createElement('input');
    input.className = 'modal-input';
    input.type = 'number';
    input.min = '0';
    input.max = '30';
    input.step = '1';
    input.value = String(Math.round((sec || 0) / 60));
    wrap.appendChild(input);
    return { wrap, input };
  };
  const before = mkInput('Vorlauf (Min.)', entry.bufferBeforeSec);
  const after = mkInput('Nachlauf (Min.)', entry.bufferAfterSec);
  const msg = document.createElement('span');
  let allowOverLimit = false;
  const save = scheduleRowButton('Speichern', async () => {
    const toSec = input => Math.round(Math.min(30, Math.max(0, Number(input.value) || 0)) * 60);
    save.disabled = true;
    try {
      const patch = { bufferBeforeSec: toSec(before.input), bufferAfterSec: toSec(after.input) };
      if (allowOverLimit) patch.allowOverLimit = true;
      const result = await window.electronAPI.updateSchedule(entry.id, patch);
      if (result && result.ok === false && result.code === 'CONFLICT') {
        msg.textContent = scheduleUi.describeConflict(result.conflict);
        allowOverLimit = true;
        save.textContent = 'Trotzdem speichern';
        save.disabled = false;
        return;
      }
      scheduleEditingId = null;
      renderRecordingDashboard();
    } catch (e) {
      msg.textContent = scheduleUi.ipcErrorMessage(e);
      save.disabled = false;
    }
  });
  const cancel = scheduleRowButton('Abbrechen', () => {
    scheduleEditingId = null;
    renderRecordingDashboard();
  });
  form.append(before.wrap, after.wrap, save, cancel, msg);
  return form;
}

function cancelScheduleEntry(entry, button) {
  // Bestätigung nur, wenn die Aufnahme gleich startet (< 30 Min.) — sonst sofort
  const startMs = Date.parse(entry.epgStart);
  const soon = Number.isFinite(startMs) && startMs - Date.now() < 30 * 60 * 1000;
  if (soon && button.dataset.confirm !== '1') {
    button.dataset.confirm = '1';
    button.textContent = 'Wirklich absagen?';
    setTimeout(() => {
      if (button.isConnected) {
        button.dataset.confirm = '';
        button.textContent = 'Absagen';
      }
    }, 4000);
    return;
  }
  button.disabled = true;
  window.electronAPI.removeSchedule(entry.id).catch(e => {
    showTvToast('Absagen nicht möglich: ' + scheduleUi.ipcErrorMessage(e));
    button.disabled = false;
  });
}

function removeScheduleEntry(entry, button) {
  button.disabled = true;
  window.electronAPI.removeSchedule(entry.id).catch(e => {
    showTvToast('Entfernen nicht möglich: ' + scheduleUi.ipcErrorMessage(e));
    button.disabled = false;
  });
}

function renderScheduleInto(listEl) {
  window.electronAPI
    .listSchedules()
    .then(entries => {
      listEl.textContent = '';
      const { upcoming, history } = scheduleUi.splitScheduleEntries(entries || []);
      scheduleHasUpcoming = upcoming.length > 0;
      refreshWakeHint();
      if (!upcoming.length && !history.length) {
        const empty = document.createElement('div');
        empty.className = 'recordings-empty';
        empty.id = 'scheduleEmpty';
        empty.textContent =
          'Keine Aufnahmen geplant. Öffne im Programmführer eine kommende Sendung und wähle „Aufnehmen“.';
        listEl.appendChild(empty);
        return;
      }
      const section = (label, items) => {
        if (!items.length) return;
        const head = document.createElement('div');
        head.className = 'schedule-section-title';
        head.textContent = label;
        listEl.appendChild(head);
        for (const entry of items) listEl.appendChild(buildScheduleRow(entry));
      };
      section('Anstehend', upcoming);
      section('Verlauf', history);
    })
    .catch(e => {
      listEl.textContent = '';
      const err = document.createElement('div');
      err.className = 'recordings-empty';
      err.textContent = 'Planung konnte nicht geladen werden: ' + scheduleUi.ipcErrorMessage(e);
      listEl.appendChild(err);
    });
}

/**
 * Wiedergabe über bestehenden Player (Overlay mit <video>): fertige MP4 via
 * rec:// direkt; laufende Aufnahme über die HLS-Zwischenform (hls.js ist auf
 * dieser Seite global geladen).
 */
async function openRecordingPlayback(meta) {
  try {
    const file = await window.electronAPI.getRecordingFile(meta.id);
    closeRecordingPlayback();
    hideRecordingPlayerError();
    recordingPlayer.style.display = 'flex';
    if (file.kind === 'hls' && typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false });
      recordingPlaybackHls = hls;
      hls.loadSource(file.url);
      hls.attachMedia(recordingPlayerVideo);
      recordingPlayerVideo.play().catch(() => {});
    } else {
      recordingPlayerVideo.src = file.url;
      recordingPlaybackUrl = file.url;
      recordingPlayerVideo.play().catch(() => {});
    }
  } catch (e) {
    showTvToast('Wiedergabe nicht möglich: ' + (e?.message || e));
  }
}

// Media-Element-Fehlermonitor des Aufnahmen-Players (Fix-Set 4). 'error'
// feuert nur beim LADEN (MediaError, code 1-4); Dekode-Fehler mitten im
// laufenden Stream melden sich als 'decoding-error'-Event (Chromium).
// Beide Kanäle zeigen dieselbe Nutzer-Botschaft statt stummem Freeze.
recordingPlayerVideo.addEventListener('error', () => {
  const mediaError = recordingPlayerVideo.error;
  if (!mediaError) return;
  const detail = MEDIA_ERROR_CODE_TEXTS[mediaError.code] || 'Wiedergabe abgebrochen.';
  showRecordingPlayerError(detail + ' (Fehlercode ' + mediaError.code + ')');
});

if (typeof recordingPlayerVideo.addEventListener === 'function') {
  recordingPlayerVideo.addEventListener('decoding-error', () => {
    showRecordingPlayerError('Fehler beim Dekodieren des Video-Streams — Teile der Aufnahme können nicht angezeigt werden.');
  });
}

let recordingPlaybackHls = null;

function closeRecordingPlayback() {
  if (recordingPlaybackHls) {
    try { recordingPlaybackHls.destroy(); } catch (_e) { /* schon weg */ }
    recordingPlaybackHls = null;
  }
  recordingPlayerVideo.pause();
  recordingPlayerVideo.removeAttribute('src');
  recordingPlayerVideo.load();
  recordingPlaybackUrl = null;
  hideRecordingPlayerError();
  recordingPlayer.style.display = 'none';
}

recordingPlayerClose.addEventListener('click', closeRecordingPlayback);

const recordingsBtn = document.getElementById('recordingsBtn'); // entfernt (Fix-Set 4)
if (recordingsBtn) recordingsBtn.addEventListener('click', () => showDashboard('recording'));

// Tray → App: „Aufnahmen-Bibliothek“ bzw. „Planung öffnen“ im Tray-Menü öffnet den
// Dashboard-Bereich Aufnahmen im Tab „Bibliothek“ bzw. „Geplant“ (Whitelist, fester Wert)
window.electronAPI.onOpenRecordings?.(data => {
  const tab = data && data.tab;
  if (tab === 'library' || tab === 'planned') {
    recordingDashboardTab = tab;
    scheduleEditingId = null;
  }
  showDashboard('recording');
});

// Shutdown-Warnung (Linux, User-Beschluss 30.09: In-App-Warnung statt Block):
// sichtbarer Hinweis im App-Fenster, falls offen.
window.electronAPI.onShutdownWarning?.(data => {
  showTvToast((data && data.message) || 'Der Computer wird heruntergefahren — laufende Aufnahmen werden beendet.');
});

// Fenster der Roh-EPG-Einträge für die DVR-Marker in tv.html: 3 h zurück, 2 h voraus
const DVR_EPG_PAST_MS = 3 * 3600 * 1000;
const DVR_EPG_AHEAD_MS = 2 * 3600 * 1000;

/**
 * epg-update-Nachricht für tv.html: Jetzt/Nächste frisch aus dem Main plus Sendungen rund ums DVR-Fenster.
 * tv.html erwartet XMLTV-Zeitstrings — der Adapter (lib/epg/renderer-adapter.js) wandelt die ms des Main um.
 * Ohne EPG: leere Felder und epgEntries [] (kein Fehlerzustand im Player).
 */
async function buildEpgUpdateMessage(ch) {
  const now = Date.now();
  let entries = [];
  try {
    const key = epgAdapter.channelEpgKey(ch);
    if (key) {
      const rows = await window.electronAPI.getEpgRangeMany([key], now - DVR_EPG_PAST_MS, now + DVR_EPG_AHEAD_MS);
      entries = epgAdapter.slotsToXmltvEntries(rows && rows[0] && rows[0].slots);
    }
  } catch (err) {
    logger.warn('EPG-Fenster für den Player nicht verfügbar:', err.message);
  }
  await reloadEpgNowNext([ch]);
  const ctx = buildEpgContextForChannel(ch);
  return {
    type: 'epg-update',
    epg: ctx.epgTitle,
    epgStart: ctx.epgStart,
    epgEnd: ctx.epgEnd,
    epgNext: ctx.epgNext,
    dvr: dvrBarMode(),
    epgEntries: entries,
  };
}

async function sendEpgUpdate() {
  if (!tvActiveChannelId) return;
  const ch = tvChannels.find(c => c.id === tvActiveChannelId);
  if (!ch) return;
  try {
    const data = await buildEpgUpdateMessage(ch);
    // Kanal während der Abfrage gewechselt: veraltete Antwort verwerfen
    if (tvActiveChannelId !== ch.id) return;
    tvView.send('tv-player-command', data);
  } catch (err) {
    logger.warn('sendEpgUpdate failed:', err);
  }
}

// U1: DVR-Scrub-Bar-Modus ('auto' = Player entscheidet am DVR-Fenster,
// 'on' = Host zwingt die DVR-Bar an, 'off' = Legacy-Balken wie v0.4.82).
// Normalisiert auf erlaubte Werte — defensiv gegen kaputte Builds.
function dvrBarMode() {
  switch (window.__streamingHubDvrBarMode) {
    case 'on':
    case 'off':
      return window.__streamingHubDvrBarMode;
    default:
      return 'auto';
  }
}

// U2: EPG-Rohdaten aktiv an tv.html pushen — beim Kanalwechsel (statt nur auf
// den 30s-Poll des Players zu warten). Der Player rendert die DVR-Marker,
// sobald EPG + DVR-Fenster vorliegen; nicht an weitere Events gekoppelt.
function pushEpgToTvView() {
  return sendEpgUpdate();
}

// Webview events
function allowContentNavigation(event) {
  try {
    const target = new URL(event.url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') event.preventDefault();
  } catch (_) {
    event.preventDefault();
  }
}

function allowTvNavigation(event) {
  try {
    const target = new URL(event.url);
    const allowed = target.protocol === 'about:' && target.href === 'about:blank';
    const localTvPage = target.protocol === 'file:' && target.pathname.endsWith('/tv.html');
    if (!allowed && !localTvPage) event.preventDefault();
  } catch (_) {
    event.preventDefault();
  }
}

webview.addEventListener('will-navigate', allowContentNavigation);
webview.addEventListener('will-redirect', allowContentNavigation);
webview.addEventListener('new-window', event => event.preventDefault());

tvView.addEventListener('will-navigate', allowTvNavigation);
tvView.addEventListener('will-redirect', allowTvNavigation);
tvView.addEventListener('new-window', event => event.preventDefault());

webview.addEventListener('did-attach', () => {
  webviewReady = true;

  if (webview.session) {
    const filter = { urls: ['*://*/*'] };
    webview.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      details.requestHeaders['User-Agent'] = currentUA;
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
      if (webview === tvView) {
        tvView.send('tv-player-command', {
          type: 'channel-list',
          channels: cl.channels,
          currentIndex: cl.currentIndex,
        });
      }
    }
  }
});

webview.addEventListener('did-navigate', () => {
  const url = webview.getURL();
  // Letzte URL des aktiven Dienstes tracken (Basis für die Zurück-Historie)
  if (currentProvider && currentProvider !== '__tv__' && url && url !== 'about:blank') {
    lastUrlByService[currentProvider] = url;
  }
  for (const svc of services) {
    if (url.includes(svc.id) || url.startsWith(svc.url)) {
      currentProvider = svc.id;
      break;
    }
  }
  updateBackBtn();
});

webview.addEventListener('did-navigate-in-page', e => {
  if (!currentProvider || currentProvider === '__tv__') return;
  const url = (e && e.url) || webview.getURL();
  if (!url || url === 'about:blank') return;
  lastUrlByService[currentProvider] = url;
  updateBackBtn();
});

webview.addEventListener('permissionrequest', e => {
  if (e.permission === 'media' || e.permission === 'mediaKeySystemAccess') {
    e.request.allow();
  } else {
    e.request.deny();
  }
});

// ── Webview Error Recovery (contentView) ──

webview.addEventListener('enter-html-full-screen', () => {
  overlayBar.classList.add('is-fullscreen');
});
webview.addEventListener('leave-html-full-screen', () => {
  overlayBar.classList.remove('is-fullscreen');
});
webview.addEventListener('did-fail-load', e => {
  if (e.errorCode === -3) return;
  if (!e.isMainFrame) return;
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

tvView.addEventListener('enter-html-full-screen', () => {
  overlayBar.classList.add('is-fullscreen');
});
tvView.addEventListener('leave-html-full-screen', () => {
  overlayBar.classList.remove('is-fullscreen');
});
tvView.addEventListener('did-attach', () => {
  tvViewReady = true;

  if (tvView.session) {
    const filter = { urls: ['*://*/*'] };
    tvView.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      details.requestHeaders['User-Agent'] = currentUA;
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
      tvView.send('tv-player-command', {
        type: 'channel-list',
        channels: cl.channels,
        currentIndex: cl.currentIndex,
      });
      // U2: Auch beim ersten TV-Seiten-Load EPG sofort pushen (die URL-Params
      // tragen nur Titel/Zeiten, keine Roh-EPG-Einträge für die DVR-Marker).
      pushEpgToTvView();
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
    // A-Fail R2-FB-01 (t_d6ee955e): tv.html fragt nach Kanal-Kontext (direct
    // nach dem TV-Initial-Load, falls Selector/setupChannel ohne channelId
    // lief). Antwort: dieselbe switch-channel-Message wie der isTvPage-Pfad —
    // tv.html ruft setupChannel damit NOCH NICHT auf, sondern aktualisiert
    // NUR recChannelCtx (pure context apply, kein zweiter HLS-Load).
    else if (e.args[0].action === 'channel-context') pushChannelContextToTvView();
    // ── Aufnahme-Requests aus tv.html (Phase 1c) ──
    else if (e.args[0].action === 'recording-status') pushRecordingStatusToTvView();
    else if (e.args[0].action === 'recording-start') {
      const ch = tvChannels.find(c => c.id === tvActiveChannelId);
      if (!ch) return;
      const epgStopMs = currentEpgStopMs(epgListForChannel(ch), Date.now());
      // Karte t_f36663be, Item 2 (Option D = B + C): tv.html liefert den
      // DVR-Rückstand (startOffsetSec, aus der Scrub-/EPG-Position) im Request
      // mit. 0/undefined = Live-Head (Bestandsverhalten).
      const rawOffset = Number(e.args[0].payload?.startOffsetSec);
      const startOffsetSec = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
      startRecordingFromRequest({
        channelId: ch.id,
        channelName: ch.name,
        epgTitle: currentEpgTitle(ch),
        untilEpgEnd: !!e.args[0].payload?.untilEpgEnd,
        epgStopMs,
        startOffsetSec,
      }).catch(err => showTvToast('Aufnahme konnte nicht gestartet werden: ' + (err?.message || err)));
    } else if (e.args[0].action === 'recording-stop') {
      const recId = e.args[0].payload?.recId;
      if (typeof recId !== 'string' || !recId) return;
      stopRecordingById(recId).catch(err => showTvToast('Aufnahme konnte nicht gestoppt werden: ' + (err?.message || err)));
    }
  }
});

// ── tvView Error Recovery ──

tvView.addEventListener('did-fail-load', e => {
  if (e.errorCode === -3) return;
  if (!e.isMainFrame) return;
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
// Fix-Set 4: PiP-Button aus der Navbar entfernt (Funktion nicht unterstützt —
// Verkabelung schläft im Hintergrund; window.electronAPI.togglePip bleibt
// erreichbar über Tastatur-Shortcut in main.js, sobald PiP unterstützt wird).

historyBtn.addEventListener('click', toggleHistory);
historyClose.addEventListener('click', closeHistory);
historyOverlay.addEventListener('click', e => {
  if (e.target === historyOverlay) closeHistory();
});
historyClear.addEventListener('click', () => {
  if (!confirm('Gesamten Verlauf löschen?')) return;
  window.electronAPI.clearHistory().then(renderHistory);
});

// Keyboard shortcut handler (shared for document + webview forwarding)
function handleKeyShortcut(key, ctrlKey, shiftKey, metaKey, altKey) {
  if (key === 'Escape') {
    if (recLimitPending) {
      closeRecordingLimitDialog(false); // Soft-Limit-Dialog: Esc = „Verwerfen“
      return true;
    }
    if (shortcutsOverlay.classList.contains('open')) {
      shortcutsOverlay.classList.remove('open');
      return true;
    }
    // Programmführer liegt über allem anderen: erst Rückfrage, dann Detail-Modal, dann Overlay
    if (epgView.handleEscape()) return true;
    if (currentDashboardGroup === 'settings') {
      goToStartPage();
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

  if (altKey && key === 'ArrowLeft') {
    return handleBackNavigation();
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

  // Aufnahmen-Dashboard (Fix-Set 4): Strg+R öffnet den Dashboard-Bereich
  if (ctrlKey && (key === 'r' || key === 'R')) {
    showDashboard('recording');
    return true;
  }

  if (ctrlKey && (key === 't' || key === 'T')) {
    showDashboard('livetv');
    return true;
  }

  if (key === 'ArrowUp' || key === 'ArrowDown') {
    // Im Programmführer scrollen die Pfeiltasten die Liste (kein Zapping dahinter)
    if (epgView.isOpen()) return false;
    const direction = key === 'ArrowUp' ? -1 : 1;
    const nextId = getNextChannelId(tvActiveChannelId, tvChannels, tvSources, direction);
    if (!nextId) {
      logger.warn('TV channel key ignored: no next channel', {
        current: tvActiveChannelId,
        direction,
        channels: tvChannels.length,
      });
      return true;
    }
    const nextCh = tvChannels.find(ch => ch.id === nextId);
    if (nextCh) {
      selectTvChannel(nextCh);
    }
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
      } else if (currentDashboardGroup === 'settings') {
        goToStartPage();
        e.preventDefault();
      } else if (historyOverlay.classList.contains('open')) {
        closeHistory();
        e.preventDefault();
      }
    }
    return;
  }
  if (handleKeyShortcut(e.key, e.ctrlKey, e.shiftKey, e.metaKey, e.altKey)) {
    e.preventDefault();
  }
});

// Forwarded shortcuts from webview (via main process)
const cleanupShortcuts = window.electronAPI.onWebviewKeydown(data => {
  if (data.key === 'ArrowUp' || data.key === 'ArrowDown') logger.info('webview-keydown received:', data.key);
  handleKeyShortcut(data.key, data.ctrlKey, data.shiftKey, data.metaKey, data.altKey);
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

let updateAvailableVersion = null;
let updateChecking = false;
let updateLastCheckedAt = 0;
let updateCheckError = null;
let updateNotes = [];

function setUpdateState(state) {
  updateBtn.classList.remove('update-available', 'uptodate');
  if (state === 'checking') {
    updateBtn.title = 'Suche…';
    updateBtn.disabled = true;
  } else if (state === 'uptodate') {
    updateBtn.title = 'Update auf dem neuesten Stand';
    updateBtn.disabled = false;
    updateBtn.classList.add('uptodate');
  } else if (state === 'error') {
    updateBtn.title = `Update-Prüfung fehlgeschlagen: ${updateCheckError || 'Unbekannter Fehler'} – erneut versuchen`;
    updateBtn.disabled = false;
  } else if (state === 'available') {
    updateBtn.title = `Update v${updateAvailableVersion} verfügbar – Klicken für Änderungen und Installation`;
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

async function checkForUpdates({ quiet = false } = {}) {
  if (updateChecking) return null;
  updateChecking = true;
  if (!quiet) setUpdateState('checking');
  try {
    const result = await window.electronAPI.checkForUpdate();
    updateCheckError = result.error || null;
    if (result.hasUpdate && result.latestVersion) {
      updateAvailableVersion = result.latestVersion;
      updateNotes = Array.isArray(result.notes) ? result.notes : [];
      setUpdateState('available');
    } else {
      updateAvailableVersion = null;
      setUpdateState(result.error ? 'error' : 'uptodate');
    }
    return result;
  } catch (error) {
    updateAvailableVersion = null;
    updateCheckError = error.message;
    setUpdateState('error');
    return { hasUpdate: false, error: error.message };
  } finally {
    updateChecking = false;
    updateLastCheckedAt = Date.now();
    if (updateButtonHovered) showUpdateStatusNotice();
  }
}

// ── Update Overlay ──
const updateNotice = document.getElementById('updateNotice');
let updateNoticeTimer = null;
let updateButtonHovered = false;
const updateOverlay = document.getElementById('updateOverlay');
const updateTitle = document.getElementById('updateTitle');
const updateStep = document.getElementById('updateStep');
const updateProgressFill = document.getElementById('updateProgressFill');

function showUpdateNotice(message, isError = false) {
  updateNotice.textContent = message;
  updateNotice.classList.toggle('error', isError);
  updateNotice.hidden = false;
  if (updateNoticeTimer) clearTimeout(updateNoticeTimer);
  updateNoticeTimer = null;
}

function hideUpdateNotice() {
  if (updateButtonHovered) return;
  if (updateNoticeTimer) clearTimeout(updateNoticeTimer);
  updateNoticeTimer = setTimeout(() => {
    updateNotice.hidden = true;
    updateNoticeTimer = null;
  }, 250);
}

function showUpdateStatusNotice() {
  if (!updateButtonHovered) return;
  if (updateCheckError) {
    showUpdateNotice(`Update-Prüfung fehlgeschlagen: ${updateCheckError}`, true);
  } else if (updateAvailableVersion) {
    showUpdateNotice(`Update v${updateAvailableVersion} verfügbar. Klicken für Änderungen und Installation.`);
  } else {
    showUpdateNotice('Kein Update verfügbar. Du verwendest die aktuelle Version.');
  }
}

async function showUpdateStatusOnHover() {
  if (updateChecking) {
    showUpdateNotice('Update-Prüfung läuft…');
    return;
  }
  if (!updateLastCheckedAt || Date.now() - updateLastCheckedAt > 30000) await checkForUpdates({ quiet: true });
  showUpdateStatusNotice();
}

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
    updateAvailableVersion = null;
    updateCheckError = status.error || status.message || 'Unbekannter Fehler';
    setUpdateState('error');
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

async function handleUpdateButtonClick() {
  if (updateChecking || updateBtn.disabled || !updateAvailableVersion) return;
  updateNotice.hidden = true;
  if (updateNoticeTimer) clearTimeout(updateNoticeTimer);
  updateNoticeTimer = null;
  if (await confirmUpdateWithNotes()) {
    updateBtn.disabled = true;
    updateBtn.title = 'Installiere…';
    showUpdateOverlay(`Update v${updateAvailableVersion} wird installiert…`);
    updateStep.textContent = 'Starte Installation…';
    const result = await window.electronAPI.applyUpdate(updateAvailableVersion);
    if (!result.success) {
      hideUpdateOverlay();
      updateBtn.disabled = false;
      updateBtn.title = 'Update fehlgeschlagen';
      updateNotice.hidden = false;
      // Nur die erste Fehlerzeile im Toast — die vollständige Meldung inkl.
      // Handlungsanweisung zeigt der Fehlerdialog aus dem Main-Prozess.
      const firstErrorLine = String(result.error || 'Unbekannter Fehler').split('\n')[0];
      updateNotice.textContent = `Update fehlgeschlagen: ${firstErrorLine}`;
      setUpdateState('available');
    }
  }
}

// Zeigt die Release-Notes seit der installierten Version; resolved true bei "Installieren", false bei Abbrechen/Esc.
function confirmUpdateWithNotes() {
  const overlay = document.getElementById('updateNotesOverlay');
  const body = document.getElementById('updateNotesBody');
  const title = document.getElementById('updateNotesTitle');
  const installBtn = document.getElementById('updateNotesInstall');
  const cancelBtn = document.getElementById('updateNotesCancel');
  title.textContent = `Update v${updateAvailableVersion} verfügbar`;
  body.replaceChildren();
  renderUpdateNotes(document, body, updateNotes);
  body.scrollTop = 0;
  overlay.classList.add('open');
  installBtn.focus();
  return new Promise(resolve => {
    const finish = result => {
      overlay.classList.remove('open');
      installBtn.removeEventListener('click', onInstall);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onInstall = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = ev => {
      if (ev.target === overlay) finish(false);
    };
    const onKey = ev => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      }
    };
    installBtn.addEventListener('click', onInstall);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
  });
}

updateBtn.addEventListener('mouseenter', () => {
  updateButtonHovered = true;
  showUpdateStatusOnHover();
});
updateBtn.addEventListener('mouseleave', () => {
  updateButtonHovered = false;
  hideUpdateNotice();
});
updateBtn.addEventListener('click', handleUpdateButtonClick);

// Prüfe beim Start (nach kurzer Verzögerung)
setTimeout(checkForUpdates, 4000);

// ── Backup / Restore ──

const settingsPanel = document.getElementById('settingsPanel');
const settingsPanelHost = document.getElementById('settingsPanelHost');
const settingsView = createSettingsView(settingsPanel, {
  onShow: page => {
    if (page === 'livetv-channels' && settingsTvChannelsView) settingsTvChannelsView.render();
  },
});
settingsTvChannelsView = createTvChannelsView({
  root: settingsPanel,
  api: window.electronAPI,
  getSources: () => tvSources,
  getChannels: () => tvChannels,
  getOriginalUrls: () => tvOriginalChannelUrls,
  getEpgIndex: () => settingsEpgIds,
  getEpgChannelList: () => settingsEpgList,
  safeResourceUrl,
  safeColor,
  reload: () => loadTvChannels(true),
});
settingsTvSourcesView = createTvSourcesView({
  root: settingsPanel,
  api: window.electronAPI,
  getSources: () => tvSources,
  safeColor,
  onRefreshEpg: () => refreshEpg(),
  getEpgInfo: () => ({
    text: dashboardTvStatus.textContent,
    loadedAt: tvEpgLoadedAt,
    busy: tvEpgRefreshing || tvSourcesRefreshing,
  }),
});
const settingsPanelPlaceholder = document.createComment('settings-panel-placeholder');
settingsPanel.parentNode.insertBefore(settingsPanelPlaceholder, settingsPanel);
const settingsStatus = document.getElementById('settingsStatus');
const backupBtn = document.getElementById('backupBtn');
const restoreBtn = document.getElementById('restoreBtn');

function setSettingsStatus(message) {
  if (settingsStatus) settingsStatus.textContent = message;
}


document.querySelectorAll('input[name="tvMode"]').forEach(r => {
  r.addEventListener('change', () => {
    tvMode = r.value;
    localStorage.setItem('tvMode', tvMode);
  });
});

// settingsBtn (Fix-Set 4 entfernt, Dashboard-Kachel abdeckt Einstellungen)

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

window.electronAPI.onFullscreenState(state => {
  overlayBar.classList.toggle('is-fullscreen', state);
});

// Services laden
window.electronAPI.getServices().then(svcs => {
  services = svcs;
  renderNav();
  updateBackBtn();
});

window.electronAPI.onServicesChanged(svcs => {
  services = svcs;
  renderNav();
  renderSettingsServices();
  if (currentDashboardGroup && currentDashboardGroup !== 'settings' && !currentProvider)
    renderDashboard(currentDashboardGroup);
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
renderStartDashboard();

// TV Sources laden
window.electronAPI.getTvSources().then(async sources => {
  tvSources = sources;
  await loadTvChannels(true);
  await syncEpgFromMain();
  if (currentDashboardGroup === 'livetv' && !currentProvider) renderDashboard('livetv');
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

  settingsTvSourcesView.render();
  if (settingsTvChannelsView) settingsTvChannelsView.render();
  if (structuralChange) {
    refreshTvSourcesAndEpg();
  }
});

// ═══ Aufnahmen (Phase 1c): Engine-Events ═══
// Der Renderer ist der einzige Konsumpunkt der recording:*-Events und
// verteilt sie an Chrome (tv.html) und die Bibliothek (Auto-Stopp läuft im Main).
window.electronAPI.onRecordingStatus(data => {
  // phase-Events: {recId, phase, percent?, remainingSec?}
  if (!data || typeof data !== 'object') return;
  if (data.phase === 'remuxing' && data.recId) {
    remuxProgressMap.set(data.recId, {
      percent: typeof data.percent === 'number' ? data.percent : null,
      remainingSec: typeof data.remainingSec === 'number' ? data.remainingSec : null,
      ts: Date.now(),
    });
    updateRecordingsScreenIfVisible();
  } else if (data.phase === 'done' && data.recId) {
    remuxProgressMap.delete(data.recId);
    refreshRecordingSnapshot();
    // Fix-Set 3 · Punkt 5: done → tv.html räumt den Beenden-Zustand auf
    pushRecordingPhaseToTvView(data);
  } else if (data.phase === 'recording' || data.phase === 'stopping') {
    refreshRecordingSnapshot();
    // Fix-Set 3 · Punkt 5: Phase an tv.html weiterleiten (Chip-Beenden-Zustand)
    pushRecordingPhaseToTvView(data);
  }
});
window.electronAPI.onRecordingProgress(data => {
  // {recId, recordingSec, bytesWritten, attempt} — UI-Zwischenanzeige nutzt
  // nur die Laufzeit; die Status-Spalte der Bibliothek liest den Snapshot.
  if (!data || typeof data !== 'object' || !data.recId) return;
  refreshRecordingSnapshotThrottled();
});
window.electronAPI.onRecordingReconnecting(data => {
  // Reconnect-Hinweis als Toast (User sieht, dass die Aufnahme weiterläuft)
  if (data && typeof data === 'object' && typeof data.attempt === 'number' && data.attempt > 1) {
    showTvToast('Stream unterbrochen — Aufnahme reconnectet …');
  }
});
// Karte t_f36663be (Meldung 4, wortgleich freigegeben): DVR-Rückstand >
// Fenster → Aufnahme läuft am frühersten DVR-Segment weiter; kein Abbruch.
window.electronAPI.onRecordingSeekDegraded?.(data => {
  if (!data || typeof data !== 'object') return;
  showTvToast(
    'Aufnahme gestartet — aber ab Live-Bild. Ihre Bildposition lag außerhalb des DVR-Fensters. ' +
      'Die Aufnahme beginnt am aktuellen Live-Bild.',
  );
  logger.warn('[recorder] Start-Degrade:', data.message || '');
});
window.electronAPI.onRecordingAutoStopped?.(data => {
  // Auto-Stopp im Main: Hinweis nur bei kritischen Gründen (Speicher voll /
  // Speicherort weg) und Höchstdauer — Sendungsende ist der erwartete Normalfall.
  if (!data || typeof data !== 'object') return;
  const name = data.channelName || 'Aufnahme';
  if (data.reason === 'disk-full' || data.reason === 'storage-lost') {
    showTvToast(`Aufnahme „${name}“ beendet: ${data.message}. Sie bleibt abspielbar.`);
  } else if (data.reason === 'max-duration') {
    showTvToast(`Aufnahme „${name}“ beendet: ${data.message}.`);
  }
});
// Planung: live aktualisieren (Liste „Geplant“) und Hinweise (Spätstart, verpasst, fehlgeschlagen) zeigen
window.electronAPI.onScheduleChanged?.(data => {
  const notice = data && typeof data === 'object' ? data.notice : null;
  if (notice && notice.message) showTvToast(notice.message);
  if (currentDashboardGroup === 'recording' && recordingDashboardTab === 'planned' && !scheduleEditingId) {
    renderRecordingDashboard();
  }
  scheduleDashboardHubRefresh();
});
window.electronAPI.onRecordingChanged(data => {
  // Statuswechsel einer Aufnahme (failed/aborted/completed) → Bibliothek + Chip
  if (data && typeof data === 'object' && data.recId) remuxProgressMap.delete(data.recId);
  refreshRecordingSnapshot();
  scheduleDashboardHubRefresh();
  // Fix-Set 3 · Punkt 5: MP4-Fertig-Meldung schließt den Stopp-Flow ab —
  // der Beenden-Chip geht mit dieser Meldung in den normalen Zustand über.
  const status = data?.meta?.status;
  if (status === 'completed') {
    showTvToast('Aufnahme beendet — MP4 bereit: ' + (data.meta?.epgTitle || data.meta?.channelName || 'Aufnahme'));
  } else if (status === 'failed') {
    showTvToast('Aufnahme fehlgeschlagen: ' + (data.meta?.lastError || 'unbekannter Fehler'));
  }
});

// Gedrosselter Snapshot-Refresh (Progress-Events im Sekundentakt)
let recordingSnapshotTimer = null;
function refreshRecordingSnapshotThrottled() {
  if (recordingSnapshotTimer) return;
  recordingSnapshotTimer = setTimeout(() => {
    recordingSnapshotTimer = null;
    refreshRecordingSnapshot();
  }, 5000);
}
