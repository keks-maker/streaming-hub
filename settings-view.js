// Einstellungs-Ansicht (Issue #4, Etappe 1): Seitenleiste + genau eine Seite.
// Reine Shell: Navigation, Seitenwechsel, Merken der letzten Seite.
// Die Funktionslogik der einzelnen Optionen bleibt in renderer.js.

const STORAGE_KEY = 'settingsPage';
const DEFAULT_PAGE = 'general';

// Konfiguration der Seitenleiste. `page` verweist auf [data-settings-page].
const SETTINGS_NAV = [
  { page: 'general', label: 'Allgemein' },
  {
    key: 'livetv',
    label: 'LiveTV',
    children: [
      { page: 'livetv-sources', label: 'Quellen' },
      { page: 'livetv-channels', label: 'Sender' },
      { page: 'livetv-epg', label: 'EPG' },
      { page: 'livetv-playback', label: 'Wiedergabe' },
      { page: 'livetv-recordings', label: 'Aufnahmen' },
    ],
  },
  { page: 'streaming', label: 'Streaming' },
  { page: 'mediathek', label: 'Mediatheken' },
];

function allPages(nav = SETTINGS_NAV) {
  return nav.flatMap(entry => (entry.children ? entry.children : [entry]));
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
  const groups = new Map();
  let currentPage = null;

  function setGroupExpanded(key, expanded) {
    const group = groups.get(key);
    if (!group) return;
    group.button.setAttribute('aria-expanded', String(expanded));
    group.children.hidden = !expanded;
  }

  function buildTab(item, groupLabel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-nav-item';
    btn.setAttribute('role', 'tab');
    btn.id = `settingsTab-${item.page}`;
    btn.dataset.page = item.page;
    if (groupLabel) btn.dataset.group = groupLabel;
    btn.setAttribute('aria-selected', 'false');
    btn.tabIndex = -1;
    btn.textContent = item.label;
    const pageEl = pageEls.get(item.page);
    if (pageEl) {
      btn.setAttribute('aria-controls', pageEl.id || (pageEl.id = `settingsPage-${item.page}`));
      pageEl.setAttribute('aria-labelledby', btn.id);
    }
    btn.addEventListener('click', () => showPage(item.page));
    tabs.set(item.page, btn);
    return btn;
  }

  function build() {
    navEl.innerHTML = '';
    navEl.setAttribute('role', 'tablist');
    navEl.setAttribute('aria-orientation', 'vertical');
    nav.forEach(entry => {
      if (!entry.children) {
        navEl.appendChild(buildTab(entry));
        return;
      }
      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'settings-nav-group';
      header.setAttribute('aria-expanded', 'false');
      header.innerHTML = '<span></span><span class="settings-nav-group-chevron" aria-hidden="true">▸</span>';
      header.firstChild.textContent = entry.label;
      const list = document.createElement('div');
      list.className = 'settings-nav-children';
      list.setAttribute('role', 'presentation');
      list.hidden = true;
      entry.children.forEach(child => list.appendChild(buildTab(child, entry.label)));
      header.addEventListener('click', () => {
        setGroupExpanded(entry.key, header.getAttribute('aria-expanded') !== 'true');
      });
      groups.set(entry.key, { button: header, children: list, pages: entry.children.map(c => c.page) });
      navEl.appendChild(header);
      navEl.appendChild(list);
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
    if (addGroupSelect) addGroupSelect.value = page === 'mediathek' ? 'mediathek' : 'streaming';
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
    groups.forEach((group, key) => {
      if (group.pages.includes(page)) setGroupExpanded(key, true);
    });
    placeAddForm(page);
    if (remember) writeStoredPage(page, options.storage);
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
