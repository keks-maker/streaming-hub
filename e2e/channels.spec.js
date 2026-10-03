'use strict';

// E2E: Einstellungen → LiveTV → Sender (Issue #4, Etappe 3).
// Eigenes isoliertes Profil mit vorbefüllter tvsources.json (lokale M3U-Dateien, kein Netz):
//   Quelle A: 5000 Sender (Performance), Quelle B: 3 Sender.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KNOWN_HARMLESS = [
  'ERR_NAME_NOT_RESOLVED',
  'Failed to fetch',
  'net::ERR_',
  'Component updater failed',
  'Electron Security Warning',
  'Autofill.enable',
  'Autofill.setAddresses',
];
const isHarmless = text => KNOWN_HARMLESS.some(k => text.includes(k));

function m3u(prefix, count) {
  const lines = ['#EXTM3U'];
  for (let i = 1; i <= count; i++) {
    const n = String(i).padStart(4, '0');
    lines.push(
      `#EXTINF:-1 tvg-id="${prefix}${n}.de" tvg-logo="https://logos.invalid/${prefix}${n}.png" group-title="Gruppe ${i % 20}",Kanal ${prefix}${n}`,
      `http://streams.invalid/${prefix}${n}.m3u8`,
    );
  }
  return lines.join('\n') + '\n';
}

const SEEDED_OVERRIDES = {
  'geist-1': { name: 'Bestand', url: 'http://192.168.0.5/legacy.m3u8', fremdfeld: { a: 1 } },
  'geist-2': { tvgId: 'g2.de', tvgLogo: 'logos/g2.png' },
};

let tmpRoot;
let electronApp;
let page;
const problems = [];

async function sources() {
  return page.evaluate(() => window.electronAPI.getTvSources());
}
const rows = () => page.locator('#settingsTvChannelsList .settings-chan-row');
const row = name => page.locator('#settingsTvChannelsList .settings-chan-row', { hasText: name });
const names = async () => (await rows().locator('.settings-chan-name').allTextContents()).map(t => t.trim());

test.beforeAll(async () => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-e2e-ch-')));
  const userData = path.join(tmpRoot, 'userData');
  const home = path.join(tmpRoot, 'home');
  fs.mkdirSync(userData);
  fs.mkdirSync(home);
  const fileA = path.join(tmpRoot, 'a.m3u');
  const fileB = path.join(tmpRoot, 'b.m3u');
  fs.writeFileSync(fileA, m3u('A', 5000));
  fs.writeFileSync(fileB, m3u('B', 3));
  fs.writeFileSync(
    path.join(userData, 'tvsources.json'),
    JSON.stringify([
      {
        id: 'qa',
        name: 'Quelle A',
        url: fileA,
        type: 'file',
        color: '#a78bfa',
        epgUrl: null,
        sortOrder: ['geist-sort'],
        // "Geister"-Favorit: nicht (mehr) in der Playlist, muss beim Umsortieren erhalten bleiben.
        favorites: ['geist-fav'],
        // Bestandsdaten anderer Sender inkl. unbekanntem Feld und (heute unzulässiger) privater URL:
        // müssen das Bearbeiten eines anderen Senders unverändert überstehen.
        channelOverrides: { ...SEEDED_OVERRIDES },
      },
      { id: 'qb', name: 'Quelle B', url: fileB, type: 'file', color: '#22c55e', epgUrl: null, sortOrder: [] },
    ]),
  );
  electronApp = await electron.launch({
    executablePath: require('electron'),
    args: [ROOT, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'],
    env: { ...process.env, HOME: home, STREAMING_HUB_USER_DATA: userData, STREAMING_HUB_UPDATE_URL: 'http://127.0.0.1:9' },
    timeout: 45_000,
  });
  electronApp.on('console', msg => {
    if (msg.type() === 'error' && !isHarmless(msg.text())) problems.push(`[main console] ${msg.text()}`);
  });
  page = await electronApp.firstWindow();
  page.on('pageerror', err => problems.push(`[pageerror] ${err.message}`));
  page.on('console', msg => {
    if (msg.type() === 'error' && !isHarmless(msg.text())) problems.push(`[renderer console] ${msg.text()}`);
  });
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#dashboardView').waitFor();
  await page.locator('.dashboard-section-settings').click();
  const group = page.locator('#settingsNav .settings-nav-group');
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  await page.locator('#settingsTab-livetv-channels').click();
});

test.afterAll(async () => {
  if (electronApp) {
    const proc = electronApp.process();
    await Promise.race([electronApp.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5_000))]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('Große Liste (5003 Sender): seitenweise gerendert, Seitenwechsel schnell', async () => {
  await expect(page.locator('#settingsTvChannelsCount')).toHaveText('5003 Sender', { timeout: 30_000 });
  expect(await rows().count()).toBeLessThanOrEqual(50);
  await expect(page.locator('#settingsTvChannelsPager')).toContainText('Seite 1 von 101');
  // Zeitmessung im Renderer: Klick bis Layout-Frame nach dem Neuaufbau.
  const ms = await page.evaluate(async () => {
    const next = [...window.document.querySelectorAll('#settingsTvChannelsPager button')].find(b => b.textContent.includes('Weiter'));
    const t0 = window.performance.now();
    next.click();
    await new Promise(r => window.requestAnimationFrame(() => window.requestAnimationFrame(r)));
    return window.performance.now() - t0;
  });
  expect(ms, `Seitenwechsel dauerte ${ms}ms`).toBeLessThan(500);
  await expect(page.locator('#settingsTvChannelsPager')).toContainText('Seite 2 von 101');
  // Logos laden lazy (nur sichtbare Seite im DOM).
  expect(await page.locator('#settingsTvChannelsList img.settings-chan-logo[loading="lazy"]').count()).toBeGreaterThan(0);
  await page.locator('#settingsTvChannelsPager button', { hasText: 'Zurück' }).click();
  // Nicht ladbare Logos (offline) werden zum Platzhalter statt Broken-Image-Symbol.
  // (Nur sichtbare Zeilen laden wegen loading=lazy tatsächlich.)
  await rows().first().scrollIntoViewIfNeeded();
  await expect(page.locator('#settingsTvChannelsList img.settings-chan-logo').first()).toHaveClass(/empty/);
  // Beschriftungen ohne "undefined"
  const labels = await page.locator('#settingsTvChannelsList [aria-label]').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
  expect(labels.length).toBeGreaterThan(0);
  expect(labels.every(l => !l.includes('undefined'))).toBe(true);
});

test('Suche und Quellenfilter', async () => {
  const search = page.locator('#settingsTvChannelsSearch');
  await search.fill('Kanal A4999');
  await expect(rows()).toHaveCount(1);
  await expect(page.locator('#settingsTvChannelsCount')).toHaveText('1 Sender');
  await search.fill('b0002.de');
  await expect(rows()).toHaveCount(1);
  await search.fill('');
  await expect(page.locator('#settingsTvChannelsCount')).toHaveText('5003 Sender');
  // Quelle A abwählen -> nur Quelle B
  await page.locator('#settingsTvChannelsSources .settings-chan-pill', { hasText: 'Quelle A' }).click();
  await expect(page.locator('#settingsTvChannelsCount')).toHaveText('3 Sender');
  await page.locator('#settingsTvChannelsSources .settings-chan-pill', { hasText: 'Quelle A' }).click();
  await expect(page.locator('#settingsTvChannelsCount')).toHaveText('5003 Sender');
});

test('Favoriten setzen und umsortieren (Buttons, Tastatur, Drag&Drop)', async () => {
  const search = page.locator('#settingsTvChannelsSearch');
  for (const n of ['A0003', 'A0001', 'A0002']) {
    await search.fill(`Kanal ${n}`);
    await expect(rows()).toHaveCount(1);
    await row(n).locator('[data-action="fav"]').click();
    await expect(row(n).locator('[data-action="fav"]')).toHaveAttribute('aria-pressed', 'true');
  }
  await search.fill('');
  const idsOf = async () => (await sources()).find(s => s.id === 'qa').favorites;
  const favs = await idsOf();
  expect(favs).toEqual(['geist-fav', ...favs.slice(1)]);
  expect(favs).toHaveLength(4);

  await page.locator('#settingsTvChannelsViewFav').click();
  await expect.poll(names).toEqual(['Kanal A0003', 'Kanal A0001', 'Kanal A0002']);

  // Erster sichtbarer Eintrag: "hoch" gesperrt, obwohl davor ein Geister-Favorit liegt
  await expect(row('A0003').locator('[data-action="up"]')).toBeDisabled();
  await expect(row('A0002').locator('[data-action="down"]')).toBeDisabled();

  // Button: A0002 nach oben (Tausch mit sichtbarem Nachbarn, Geist behält Platz 0)
  await row('A0002').locator('[data-action="up"]').click();
  await expect.poll(names).toEqual(['Kanal A0003', 'Kanal A0002', 'Kanal A0001']);
  expect(await idsOf()).toEqual([favs[0], favs[1], favs[3], favs[2]]);

  // Tastatur: Fokus auf "runter" von A0003, Enter -> A0003 rutscht eins nach unten, Fokus bleibt am Button
  await row('A0003').locator('[data-action="down"]').focus();
  await page.keyboard.press('Enter');
  await expect.poll(names).toEqual(['Kanal A0002', 'Kanal A0003', 'Kanal A0001']);
  await expect(row('A0003').locator('[data-action="down"]')).toBeFocused();
  // Ränder: erster Eintrag kann nicht weiter hoch
  await expect(row('A0002').locator('[data-action="up"]')).toBeDisabled();

  // Drag&Drop: A0001 vor A0002 ziehen
  await row('A0001').locator('.settings-chan-drag').dragTo(row('A0002'));
  await expect.poll(names).toEqual(['Kanal A0001', 'Kanal A0002', 'Kanal A0003']);
  const persisted = await idsOf();
  expect(persisted).toHaveLength(4);
  expect(persisted).toContain('geist-fav');
  expect(new Set(persisted).size).toBe(4);
  const reloaded = await sources();
  expect(reloaded.find(s => s.id === 'qa').sortOrder).toEqual(['geist-sort']);

  // Favorit entfernen
  await row('A0003').locator('[data-action="fav"]').click();
  await expect.poll(names).toEqual(['Kanal A0001', 'Kanal A0002']);
  await page.locator('#settingsTvChannelsViewAll').click();
});

test('Sender bearbeiten: Override speichern, validieren, zurücksetzen – ohne Datenverlust', async () => {
  const search = page.locator('#settingsTvChannelsSearch');
  await search.fill('Kanal A0001');
  const before = (await sources()).find(s => s.id === 'qa');
  await row('A0001').locator('[data-action="edit"]').click();
  const detail = row('A0001').locator('.settings-chan-detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('.settings-chan-original code')).toHaveText('http://streams.invalid/A0001.m3u8');

  // Ungültige Eingaben werden abgewiesen und nicht gespeichert
  await detail.locator('input[data-field="urlEnabled"]').check();
  await detail.locator('input[data-field="url"]').fill('http://192.168.1.5/stream.m3u8');
  await detail.getByRole('button', { name: 'Speichern' }).click();
  await expect(row('A0001').locator('.settings-chan-error')).toContainText('lokales oder privates');
  expect((await sources()).find(s => s.id === 'qa').channelOverrides).toEqual(SEEDED_OVERRIDES);
  await detail.locator('input[data-field="url"]').fill('ftp://x.example/a');
  await detail.getByRole('button', { name: 'Speichern' }).click();
  await expect(row('A0001').locator('.settings-chan-error')).toContainText('http://');

  // Gültig speichern
  await detail.locator('input[data-field="name"]').fill('Eins');
  await detail.locator('input[data-field="tvgId"]').fill('eins.de');
  await detail.locator('input[data-field="tvgLogo"]').fill('https://logos.invalid/eins.png');
  await expect(detail.locator('.settings-chan-logo-preview')).toBeVisible();
  await detail.locator('input[data-field="url"]').fill('https://streams.invalid/override.m3u8');
  await detail.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('#settingsTvChannelsStatus')).toContainText('gespeichert');

  const after = (await sources()).find(s => s.id === 'qa');
  const chId = Object.keys(after.channelOverrides).find(k => !(k in SEEDED_OVERRIDES));
  expect(chId).toBeTruthy();
  // Overrides anderer Sender (inkl. unbekanntem Feld) bleiben unverändert erhalten.
  expect(after.channelOverrides['geist-1']).toEqual(SEEDED_OVERRIDES['geist-1']);
  expect(after.channelOverrides['geist-2']).toEqual(SEEDED_OVERRIDES['geist-2']);
  expect(Object.keys(after.channelOverrides)).toHaveLength(3);
  expect(after.channelOverrides[chId]).toEqual({
    name: 'Eins',
    tvgId: 'eins.de',
    tvgLogo: 'https://logos.invalid/eins.png',
    url: 'https://streams.invalid/override.m3u8',
  });
  for (const key of ['id', 'name', 'url', 'type', 'color', 'epgUrl', 'favorites', 'sortOrder']) {
    expect(after[key], key).toEqual(before[key]);
  }
  await search.fill('Eins');
  await expect(row('Eins')).toBeVisible();
  await expect(row('Eins')).toContainText('URL überschrieben');
  await expect(row('Eins').locator('.settings-chan-tvgid')).toHaveText('eins.de');

  // Zurücksetzen: URL auf Original, Felder leeren -> Override-Eintrag verschwindet
  await row('Eins').locator('[data-action="edit"]').click();
  const d2 = row('Eins').locator('.settings-chan-detail');
  await d2.locator('[data-action="reset-url"]').click();
  await d2.locator('input[data-field="name"]').fill('');
  await d2.locator('input[data-field="tvgId"]').fill('');
  await d2.locator('input[data-field="tvgLogo"]').fill('');
  await d2.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('#settingsTvChannelsStatus')).toContainText('gespeichert');
  const reset = (await sources()).find(s => s.id === 'qa');
  expect(reset.channelOverrides).toEqual(SEEDED_OVERRIDES);
  await search.fill('Kanal A0001');
  await expect(row('A0001')).toBeVisible();
  await expect(row('A0001')).not.toContainText('URL überschrieben');
  await search.fill('');
});

test('Ungespeicherte Eingaben im Detailbereich überstehen tv-sources-changed', async () => {
  await page.locator('#settingsTvChannelsSearch').fill('Kanal A0002');
  await row('A0002').locator('[data-action="edit"]').click();
  const input = row('A0002').locator('.settings-chan-detail input[data-field="name"]');
  await input.fill('Halb getippt');
  await input.focus();
  // Broadcast auslösen (Farbe einer anderen Quelle ändern).
  await page.evaluate(() => window.electronAPI.updateTvSource('qb', { color: '#112233' }));
  await expect.poll(async () => (await sources()).find(s => s.id === 'qb').color).toBe('#112233');
  await expect(row('A0002').locator('.settings-chan-detail input[data-field="name"]')).toHaveValue('Halb getippt');
  await expect(row('A0002').locator('.settings-chan-detail input[data-field="name"]')).toBeFocused();
  await row('A0002').locator('.settings-chan-detail [data-action="cancel"]').click();
  await page.locator('#settingsTvChannelsSearch').fill('');
});

test('EPG-Combobox: ohne geladenes EPG verständlicher Hinweis, Tastatur schließt mit Escape', async () => {
  await page.locator('#settingsTvChannelsSearch').fill('Kanal B0001');
  await row('B0001').locator('[data-action="edit"]').click();
  const tvg = row('B0001').locator('.settings-chan-detail input[data-field="tvgId"]');
  await tvg.focus();
  await expect(row('B0001').locator('.settings-chan-combo')).toContainText('EPG nicht geladen');
  await page.keyboard.press('Escape');
  await expect(row('B0001').locator('.settings-chan-combo')).toBeHidden();
  await row('B0001').locator('.settings-chan-detail [data-action="cancel"]').click();
});

test('Seitengrenze: Verschieben über die 50er-Seite wechselt die Seite, Fokus bleibt am Eintrag', async () => {
  // 55 echte Favoriten (+ Geist) per IPC setzen.
  const fileA = await page.evaluate(async () => (await window.electronAPI.getTvSources()).find(s => s.id === 'qa').url);
  const ids = await page.evaluate(async url => (await window.electronAPI.fetchAndParseM3U(url)).channels.slice(100, 155).map(c => c.id), fileA);
  expect(ids).toHaveLength(55);
  await page.evaluate(favorites => window.electronAPI.updateTvSource('qa', { favorites }), [ids[0], 'geist-fav', ...ids.slice(1)]);
  await page.locator('#settingsTvChannelsSearch').fill('');
  await page.locator('#settingsTvChannelsViewFav').click();
  await expect(page.locator('#settingsTvChannelsPager')).toContainText('Seite 1 von 2');
  await expect(page.locator('#settingsTvChannelsCount')).toContainText('über Seitengrenzen die Pfeil-Buttons');
  await expect(rows()).toHaveCount(50);
  // Geist zwischen zwei sichtbaren Favoriten: Tausch mit dem sichtbaren Nachbarn, Geist behält Platz 1
  await expect(rows().nth(0).locator('[data-action="up"]')).toBeDisabled();
  await rows().nth(1).locator('[data-action="up"]').click();
  await expect.poll(async () => (await sources()).find(s => s.id === 'qa').favorites.slice(0, 3)).toEqual([ids[1], 'geist-fav', ids[0]]);
  await expect(rows().nth(0)).toHaveAttribute('data-channel-id', ids[1]);
  const lastOnPage = rows().nth(49);
  const key = await lastOnPage.getAttribute('data-channel-id');
  expect(key).toBe(ids[49]);
  await lastOnPage.locator('[data-action="down"]').click();
  await expect(page.locator('#settingsTvChannelsPager')).toContainText('Seite 2 von 2');
  const moved = page.locator(`#settingsTvChannelsList .settings-chan-row[data-channel-id="${ids[49]}"]`);
  await expect(moved).toBeVisible();
  await expect(moved.locator('[data-action="down"]')).toBeFocused();
  const persisted = (await sources()).find(s => s.id === 'qa').favorites;
  expect(persisted).toHaveLength(56);
  expect(persisted[1]).toBe('geist-fav');
  expect(persisted.indexOf(ids[49])).toBe(51);
  expect(new Set(persisted).size).toBe(56);
  // Rückweg über die Seitengrenze: Fokus bleibt ebenfalls erhalten
  await moved.locator('[data-action="up"]').click();
  await expect(page.locator('#settingsTvChannelsPager')).toContainText('Seite 1 von 2');
  await expect(page.locator(`#settingsTvChannelsList .settings-chan-row[data-channel-id="${ids[49]}"] [data-action="up"]`)).toBeFocused();
  await page.locator('#settingsTvChannelsViewAll').click();
});

test('Escape: Combobox-Liste bleibt zu, Einstellungen bleiben offen, Entwurf geht nicht still verloren', async () => {
  await page.locator('#settingsTvChannelsSearch').fill('Kanal B0001');
  await row('B0001').locator('[data-action="edit"]').click();
  const detail = row('B0001').locator('.settings-chan-detail');
  const tvg = detail.locator('input[data-field="tvgId"]');
  const combo = detail.locator('.settings-chan-combo');
  await tvg.focus();
  await expect(combo).toBeVisible();
  // EPG ist offline nicht geladen -> Eintrag für den Listenpfad einfügen
  await page.evaluate(() => {
    const item = window.document.createElement('button');
    item.type = 'button';
    item.className = 'settings-chan-combo-item';
    item.textContent = 'test.de';
    window.document.querySelector('.settings-chan-combo').appendChild(item);
  });
  await page.keyboard.press('ArrowDown');
  await expect(detail.locator('.settings-chan-combo-item')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(combo).toBeHidden();
  await expect(tvg).toBeFocused();
  await page.waitForTimeout(400);
  await expect(combo).toBeHidden(); // öffnet nicht erneut
  await expect(page.locator('#dashboardTitle')).toHaveText('Einstellungen');
  // Escape im Feld bei geschlossener Liste, Entwurf unverändert: schließt nur den Detailbereich
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await expect(page.locator('#dashboardTitle')).toHaveText('Einstellungen');
  // Mit ungespeicherter Änderung: Detailbereich und Eingabe bleiben, Hinweis erscheint
  await row('B0001').locator('[data-action="edit"]').click();
  const name = row('B0001').locator('.settings-chan-detail input[data-field="name"]');
  await name.fill('Geändert');
  await page.keyboard.press('Escape');
  await expect(name).toHaveValue('Geändert');
  await expect(page.locator('#settingsTvChannelsStatus')).toContainText('Ungespeicherte Änderungen');
  await expect(page.locator('#dashboardTitle')).toHaveText('Einstellungen');
  await row('B0001').locator('.settings-chan-detail [data-action="cancel"]').click();
  await page.locator('#settingsTvChannelsSearch').fill('');
});

test('Deep-Links: LiveTV-Dashboard und Senderauswahl führen zur Senderverwaltung; alte Modals sind entfernt', async () => {
  await expect(page.locator('#tvModalOverlay')).toHaveCount(0);
  await expect(page.locator('#tvChModalOverlay')).toHaveCount(0);

  // Dashboard-Button "Senderverwaltung"
  await page.locator('#overlayNav [data-section="livetv"]').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('LiveTV');
  await page.locator('#dashboardTvSettings').click();
  await expect(page.locator('#dashboardTitle')).toHaveText('Einstellungen');
  await expect(page.locator('#settingsTab-livetv-channels')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#settingsTvChannelsList')).toBeVisible();

  // Senderauswahl-Overlay ("Alle Sender") bleibt Sender-Picker und verlinkt auf die Verwaltung
  await page.locator('#settingsTab-general').click();
  await page.locator('#overlayNav [data-section="livetv"]').click();
  await page.locator('#dashboardTvManage').click();
  await expect(page.locator('#tvChannelManagerOverlay')).toHaveClass(/open/);
  await page.locator('#tvChannelManagerSettings').click();
  await expect(page.locator('#tvChannelManagerOverlay')).not.toHaveClass(/open/);
  await expect(page.locator('#settingsTab-livetv-channels')).toHaveAttribute('aria-selected', 'true');
});

test('Keine uncaught Exceptions / unerwarteten Konsolen-Errors', async () => {
  expect(problems, `Unerwartete Fehler:\n${problems.join('\n')}`).toEqual([]);
});
