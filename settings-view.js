// Einstellungs-Ansicht (Issue #4, Etappe 1): Seitenleiste + genau eine Seite.
// Reine Shell: Navigation, Seitenwechsel, Merken der letzten Seite.
// Die Funktionslogik der einzelnen Optionen bleibt in renderer.js.

const STORAGE_KEY = 'settingsPage';
const DEFAULT_PAGE = 'general';

// Konfiguration der Seitenleiste: jede Gruppe hat eine Überschrift (immer sichtbar, nicht fokussierbar) und ihre Einträge ohne
// Gruppenpräfix. `page` verweist auf [data-settings-page]; die Seiten-IDs sind Ziele von Deep-Links (openSettingsPage). `area` ist die Bereichsfarbe.
const SETTINGS_NAV = [
  { key: 'general', label: 'Allgemein', area: 'settings', children: [{ page: 'general', label: 'Sicherung' }] },
  {
    key: 'livetv',
    area: 'livetv',
    label: 'LiveTV',
    children: [
      { page: 'livetv-sources', label: 'Quellen' },
      { page: 'livetv-channels', label: 'Sender' },
      { page: 'livetv-epg', label: 'EPG' },
      { page: 'livetv-playback', label: 'Wiedergabe' },
      { page: 'livetv-recordings', label: 'Aufnahmen' },
    ],
  },
  {
    key: 'radio',
    area: 'radio',
    label: 'Radio',
    children: [
      { page: 'radio-stations', label: 'Sender' },
      { page: 'radio-custom', label: 'Eigene Sender' },
      { page: 'radio-playback', label: 'Wiedergabe' },
    ],
  },
  {
    key: 'podcasts',
    area: 'podcast',
    label: 'Podcasts',
    children: [
      { page: 'podcast-subs', label: 'Abos' },
      { page: 'podcast-feeds', label: 'Eigene Feeds' },
      { page: 'podcast-playback', label: 'Wiedergabe' },
    ],
  },
  { key: 'streaming', label: 'Streaming', area: 'streaming', children: [{ page: 'streaming', label: 'Dienste' }] },
  {
    key: 'mediathek',
    area: 'mediathek',
    label: 'Mediatheken',
    children: [
      { page: 'mediathek-sources', label: 'Quellen' },
      { page: 'mediathek-accounts', label: 'Konten' },
      { page: 'mediathek-playback', label: 'Wiedergabe' },
      { page: 'mediathek-dl-storage', label: 'Downloads: Ablage' },
      { page: 'mediathek-dl-quality', label: 'Downloads: Qualität' },
      { page: 'mediathek-dl-audio', label: 'Downloads: Ton & Untertitel' },
      { page: 'mediathek-dl-control', label: 'Downloads: Steuerung' },
      { page: 'mediathek-dl-notes', label: 'Downloads: Hinweise' },
    ],
  },
];

function allPages(nav = SETTINGS_NAV) {
  return nav.flatMap(entry => entry.children);
}

function isValidPage(page, nav = SETTINGS_NAV) {
  return allPages(nav).some(p => p.page === page);
}

function readStoredPage(storage) {
  try {
    return (storage || localStorage).getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredPage(page, storage) {
  try {
    (storage || localStorage).setItem(STORAGE_KEY, page);
  } catch {
    /* Speicher nicht verfügbar: Seite wird nur nicht gemerkt */
  }
}

// Ermittelt die anzuzeigende Seite: gewünscht > gemerkt > Allgemein.
function resolvePage(requested, stored, nav = SETTINGS_NAV) {
  if (requested && isValidPage(requested, nav)) return requested;
  if (stored && isValidPage(stored, nav)) return stored;
  return DEFAULT_PAGE;
}

function createSettingsView(panel, options = {}) {
  const nav = options.nav || SETTINGS_NAV;
  const navEl = panel.querySelector('#settingsNav');
  const pageEls = new Map();
  panel.querySelectorAll('[data-settings-page]').forEach(el => {
    pageEls.set(el.dataset.settingsPage, el);
  });
  const addForm = panel.querySelector('#settingsAddForm');
  const addGroupSelect = panel.querySelector('#settingsInputGroup');
  const tabs = new Map();
  let currentPage = null;

  function buildTab(item, headingId) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-nav-item';
    btn.setAttribute('role', 'tab');
    btn.id = `settingsTab-${item.page}`;
    btn.dataset.page = item.page;
    btn.setAttribute('aria-selected', 'false');
    btn.tabIndex = -1;
    btn.textContent = item.label;
    const pageEl = pageEls.get(item.page);
    if (pageEl) {
      btn.setAttribute('aria-controls', pageEl.id || (pageEl.id = `settingsPage-${item.page}`));
      // Name der Seite: Gruppe und Eintrag („LiveTV Quellen“), damit gleichnamige Einträge unterscheidbar bleiben
      pageEl.setAttribute('aria-labelledby', `${headingId} ${btn.id}`);
    }
    btn.addEventListener('click', () => showPage(item.page));
    tabs.set(item.page, btn);
    return btn;
  }

  function build() {
    navEl.innerHTML = '';
    nav.forEach(entry => {
      const headingId = `settingsNavHeading-${entry.key}`;
      const group = document.createElement('div');
      group.className = 'settings-nav-section';
      group.dataset.area = entry.area;
      // Echte Überschrift, kein Bedienelement: nicht fokussierbar, Screenreader springen per Überschriftennavigation
      const heading = document.createElement('h2');
      heading.className = 'settings-nav-heading';
      heading.id = headingId;
      heading.textContent = entry.label;
      const list = document.createElement('div');
      list.className = 'settings-nav-children';
      list.setAttribute('role', 'tablist');
      list.setAttribute('aria-orientation', 'vertical');
      list.setAttribute('aria-labelledby', headingId);
      entry.children.forEach(child => list.appendChild(buildTab(child, headingId)));
      group.append(heading, list);
      navEl.appendChild(group);
    });
  }

  function resetAddForm() {
    if (!addForm) return;
    addForm.style.display = 'none';
    addForm.querySelectorAll('input').forEach(input => {
      input.value = input.type === 'color' ? '#6c5ce7' : '';
    });
  }

  // Dienst-hinzufügen-Formular lebt nur einmal im DOM und wandert mit der Seite.
  function placeAddForm(page) {
    if (!addForm) return;
    const slot = pageEls.get(page)?.querySelector('[data-add-form-slot]');
    if (!slot) return;
    if (addForm.parentNode !== slot) slot.appendChild(addForm);
    resetAddForm();
    if (addGroupSelect) addGroupSelect.value = page === 'mediathek-sources' ? 'mediathek' : 'streaming';
  }

  function visibleTabs() {
    // Tatsächliche Sichtbarkeit (im schmalen Layout sind zugeklappte Gruppen per display:contents sichtbar).
    return [...tabs.values()].filter(t => t.getClientRects().length > 0);
  }

  function showPage(requested, { remember = true } = {}) {
    const page = resolvePage(requested, readStoredPage(options.storage), nav);
    currentPage = page;
    pageEls.forEach((el, key) => {
      el.hidden = key !== page;
    });
    tabs.forEach((btn, key) => {
      const selected = key === page;
      btn.setAttribute('aria-selected', String(selected));
      btn.tabIndex = selected ? 0 : -1;
    });
    const selectedTab = tabs.get(page);
    if (selectedTab && typeof selectedTab.scrollIntoView === 'function') selectedTab.scrollIntoView({ block: 'nearest' });
    placeAddForm(page);
    if (remember) writeStoredPage(page, options.storage);
    if (typeof options.onShow === 'function') options.onShow(page);
    return page;
  }

  navEl.addEventListener('keydown', e => {
    const tab = e.target.closest?.('[role="tab"]');
    if (!tab) return;
    const list = visibleTabs();
    const idx = list.indexOf(tab);
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (idx + 1) % list.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (idx - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    if (next < 0) return;
    e.preventDefault();
    list[next].focus();
    showPage(list[next].dataset.page);
  });

  build();

  return {
    showPage,
    getPage: () => currentPage,
  };
}

module.exports = {
  SETTINGS_NAV,
  DEFAULT_PAGE,
  STORAGE_KEY,
  isValidPage,
  resolvePage,
  createSettingsView,
};
