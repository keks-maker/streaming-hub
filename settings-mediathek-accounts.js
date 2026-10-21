'use strict';

// Einstellungen ▸ Mediatheken ▸ Konten (experimentell): je Sender eine Karte mit Status, Anmelden/Abmelden und
// "Freischaltung testen". Die Anmeldung läuft im Anbieter-Fenster des Main-Prozesses; hier gibt es nie Passwörter. Die optionale
// ARD-Jugendschutz-PIN geht nur an den Main-Prozess (verschlüsselt gespeichert) und wird nie wieder angezeigt.

const { el, statusLine, setStatus, formatIpcError } = require('./settings-radio-dom.js');
const { describeAccount, GENERAL_HINT, STORAGE_NOTE } = require('./settings-mediathek-accounts-model.js');

function createMediathekAccountsView(root, { mediathek, logger = null } = {}) {
  const doc = root.ownerDocument || document;
  const accounts = mediathek.accounts;
  const busy = new Set();
  let current = { accounts: [], persistent: false, pin: { supported: false, set: false, enabled: false } };
  const cards = new Map();

  const intro = el(doc, 'p', 'settings-field-hint', GENERAL_HINT);
  intro.id = 'settingsMediathekAccountsIntro';
  const storageNote = el(doc, 'p', 'settings-field-hint');
  const list = el(doc, 'div', 'settings-row settings-row-stack');
  list.setAttribute('role', 'list');
  const statusEl = statusLine(doc, 'settingsMediathekAccountsStatus');
  const pinHost = el(doc, 'div', 'settings-row settings-row-stack');
  pinHost.id = 'settingsMediathekAccountsPin';
  root.textContent = '';
  root.append(intro, storageNote, list, pinHost, statusEl);

  function button(label, id, onClick) {
    const node = el(doc, 'button', 'settings-btn settings-account-btn', label);
    node.type = 'button';
    node.id = id;
    node.addEventListener('click', onClick);
    return node;
  }

  function buildCard(sender) {
    const card = el(doc, 'div', 'settings-account-card');
    card.setAttribute('role', 'listitem');
    card.dataset.sender = sender;
    const title = el(doc, 'h5', 'settings-card-title settings-account-title');
    const badge = el(doc, 'span', 'settings-badge', 'experimentell');
    const state = el(doc, 'p', 'settings-field-hint');
    state.id = `settingsMediathekAccount-${sender}-state`;
    const hint = el(doc, 'p', 'settings-field-hint');
    const login = button('Anmelden', `settingsMediathekAccount-${sender}-login`, () => run(sender, 'login'));
    const logout = button('Abmelden', `settingsMediathekAccount-${sender}-logout`, () => run(sender, 'logout'));
    const test = button('Freischaltung testen', `settingsMediathekAccount-${sender}-test`, () => run(sender, 'test'));
    const diagnose = button('Ablauf aufzeichnen (Diagnose)', `settingsMediathekAccount-${sender}-diagnose`, () => run(sender, 'diagnose'));
    diagnose.hidden = true;
    for (const node of [login, logout, test, diagnose]) node.setAttribute('aria-describedby', state.id);
    const actions = el(doc, 'div', 'settings-account-actions');
    actions.append(login, logout, test, diagnose);
    card.append(title, badge, state, hint, actions);
    cards.set(sender, { card, title, badge, state, hint, login, logout, test, diagnose, actions });
    return card;
  }

  function renderCards() {
    for (const account of current.accounts) {
      if (!cards.has(account.sender)) list.append(buildCard(account.sender));
      const parts = cards.get(account.sender);
      const info = describeAccount(account, { busy: busy.has(account.sender) });
      parts.title.textContent = info.title;
      parts.badge.hidden = !info.badge;
      parts.state.textContent = info.statusText;
      parts.state.dataset.kind = info.statusKind;
      parts.hint.textContent = info.hint;
      parts.login.textContent = info.loginLabel;
      parts.login.hidden = !info.supported;
      parts.logout.hidden = !info.supported;
      parts.test.hidden = !info.supported;
      parts.login.disabled = !info.canLogin;
      parts.logout.disabled = !info.canLogout;
      parts.test.disabled = !info.canTest;
      parts.diagnose.hidden = !(info.supported && account.canDiagnose === true);
      parts.diagnose.disabled = !info.canDiagnose;
    }
    storageNote.textContent = current.persistent ? STORAGE_NOTE.persistent : STORAGE_NOTE.memoryOnly;
  }

  function renderPin() {
    pinHost.textContent = '';
    pinHost.hidden = !current.pin.supported;
    if (!current.pin.supported) return;
    const heading = el(doc, 'h5', 'settings-card-title', 'ARD: Jugendschutz-PIN (optional, experimentell)');
    const label = el(doc, 'label', 'tv-mode-label');
    const input = el(doc, 'input');
    input.type = 'password';
    input.id = 'settingsMediathekAccountsPinInput';
    input.inputMode = 'numeric';
    input.maxLength = 4;
    input.autocomplete = 'off';
    input.setAttribute('aria-describedby', 'settingsMediathekAccountsPinHint');
    label.append(el(doc, 'span', '', 'PIN (4 Ziffern): '), input);
    const save = button('PIN speichern', 'settingsMediathekAccountsPinSave', async () => {
      if (!/^\d{4}$/.test(input.value)) return setStatus(statusEl, 'Die PIN besteht aus genau vier Ziffern.', true);
      await call(() => accounts.setPin(input.value), 'PIN gespeichert (verschlüsselt).');
      input.value = '';
    });
    const clear = button('PIN entfernen', 'settingsMediathekAccountsPinClear', () => call(() => accounts.setPin(null), 'PIN entfernt.'));
    clear.disabled = !current.pin.set;
    const toggleLabel = el(doc, 'label', 'tv-mode-label');
    const toggle = el(doc, 'input');
    toggle.type = 'checkbox';
    toggle.id = 'settingsMediathekAccountsPinEnabled';
    toggle.checked = current.pin.enabled;
    toggle.disabled = !current.pin.set;
    toggle.addEventListener('change', () => call(() => accounts.setPinEnabled(toggle.checked), toggle.checked ? 'PIN-Übermittlung aktiviert (experimentell).' : 'PIN-Übermittlung aus.'));
    toggleLabel.append(toggle, el(doc, 'span', '', ' PIN beim Abruf mitsenden (experimentell)'));
    const hint = el(doc, 'p', 'settings-field-hint', `${current.pin.set ? 'Eine PIN ist gespeichert. ' : ''}Die PIN wird nur verschlüsselt abgelegt, nie angezeigt und nur an den dafür vorgesehenen ARD-Abruf gesendet. Nach bisherigem Stand verlangt die ARD keine Jugendschutz-PIN (nur Anmeldung und Altersfreigabe beim Anbieter); die Einstellung bleibt daher ohne Wirkung und die PIN wird nicht gesendet.`);
    hint.id = 'settingsMediathekAccountsPinHint';
    pinHost.append(heading, label, save, clear, toggleLabel, hint);
  }

  function show(status) {
    current = {
      accounts: Array.isArray(status.accounts) ? status.accounts : [],
      persistent: status.persistent === true,
      pin: status.pin || { supported: false, set: false, enabled: false },
    };
    renderCards();
    renderPin();
  }

  async function call(run, successText) {
    try {
      const result = await run();
      if (result && result.status) show(result.status);
      if (result && result.ok === false) return setStatus(statusEl, result.message || 'Das hat nicht geklappt.', true);
      setStatus(statusEl, successText || (result && result.message) || '');
    } catch (error) {
      if (logger) logger.warn('Mediathek-Konten:', error && error.message ? error.message : error);
      setStatus(statusEl, formatIpcError(error), true);
    }
  }

  async function run(sender, action) {
    busy.add(sender);
    renderCards();
    setStatus(statusEl, action === 'login' ? 'Anbieter-Fenster geöffnet: dort anmelden …' : action === 'diagnose' ? 'Aufzeichnung läuft: im Fenster einen gesperrten Beitrag öffnen und die PIN bzw. Altersfreigabe dort eingeben, danach das Fenster schließen. Es werden nur Namen und Statuscodes gespeichert, keine Werte, Token oder PIN.' : action === 'test' ? 'Prüfe …' : 'Melde ab …');
    try {
      if (action === 'login') await call(() => accounts.login(sender), 'Angemeldet. Beiträge, die der Anbieter für dich freigibt, sind jetzt abrufbar.');
      else if (action === 'diagnose') await call(() => accounts.diagnose(sender), null);
      else if (action === 'logout') await call(() => accounts.logout(sender), 'Abgemeldet. Sitzungsdaten wurden gelöscht.');
      else await call(() => accounts.test(sender), null);
    } finally {
      busy.delete(sender);
      renderCards();
    }
  }

  async function refresh() {
    try {
      const status = await accounts.status();
      show(status);
      setStatus(statusEl, '');
    } catch (error) {
      if (logger) logger.warn('Mediathek-Konten konnten nicht geladen werden:', error && error.message ? error.message : error);
      setStatus(statusEl, formatIpcError(error), true);
    }
  }

  if (typeof accounts.onChanged === 'function') accounts.onChanged(status => show(status));

  return { refresh, show };
}

module.exports = { createMediathekAccountsView };
