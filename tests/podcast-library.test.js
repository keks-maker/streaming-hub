'use strict';

// Tests: Hörzustand (podcast-state.js), PodcastLibrary (Persistenz), Katalog-Abgleich (podcast-sources-merge.js),
// mitgelieferte Liste (podcastsources.json) und Nach-Update-Reconciliation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const state = require('../lib/podcast/podcast-state.js');
const { PodcastLibrary } = require('../lib/podcast/PodcastLibrary.js');
const { reconcileSubscriptions } = require('../lib/podcast/podcast-sources-merge.js');
const { reconcilePodcastSources } = require('../lib/post-update-reconcile.js');
const { podcastIdFromFeedUrl } = require('../lib/podcast/podcast-ids.js');
const { podcastFeedUrlError } = require('../lib/input-validation.js');
const { createUserStorage } = require('../lib/user-storage.js');

const T0 = new Date('2026-10-15T10:00:00Z');

function tmpStorage(bundle = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-hub-podcast-'));
  const userDataPath = path.join(root, 'user');
  const bundlePath = path.join(root, 'bundle');
  fs.mkdirSync(bundlePath, { recursive: true });
  for (const [name, value] of Object.entries(bundle)) fs.writeFileSync(path.join(bundlePath, name), JSON.stringify(value));
  return { root, userDataPath, bundlePath, storage: createUserStorage({ userDataPath, bundlePath }) };
}

test('Hörzustand: Position speichern, Dauer bleibt, Auto-„gehört“ ab 95 % setzt Position zurück', () => {
  let s = state.createState();
  s = state.savePosition(s, 'p', 'e', { position: 100, duration: 1000 }, T0);
  assert.deepEqual(state.getEpisodeState(s, 'p', 'e'), { position: 100, duration: 1000, played: false, updatedAt: T0.toISOString() });
  s = state.savePosition(s, 'p', 'e', { position: 500 }, T0);
  assert.equal(state.getEpisodeState(s, 'p', 'e').duration, 1000, 'bekannte Dauer bleibt');
  s = state.savePosition(s, 'p', 'e', { position: 949 }, T0);
  assert.equal(state.getEpisodeState(s, 'p', 'e').played, false, '94,9 %');
  s = state.savePosition(s, 'p', 'e', { position: 950 }, T0);
  const done = state.getEpisodeState(s, 'p', 'e');
  assert.equal(done.played, true, '95 %');
  assert.equal(done.position, 0);
  s = state.savePosition(s, 'p', 'e', { position: 30 }, T0);
  assert.equal(state.getEpisodeState(s, 'p', 'e').played, true, 'bleibt gehört beim Wiederhören');
  assert.deepEqual(state.getEpisodeState(s, 'p', 'unbekannt'), { position: 0, duration: null, played: false, updatedAt: null });
});

test('Hörzustand: ohne Dauer nie automatisch gehört; setPlayed setzt zurück; Eingabe bleibt unverändert', () => {
  const s0 = state.createState();
  const s1 = state.savePosition(s0, 'p', 'e', { position: 99999 }, T0);
  assert.equal(state.getEpisodeState(s1, 'p', 'e').played, false);
  assert.deepEqual(s0.episodes, {});
  const s2 = state.setPlayed(s1, 'p', 'e', true, T0);
  assert.equal(state.getEpisodeState(s2, 'p', 'e').played, true);
  assert.equal(state.getEpisodeState(s2, 'p', 'e').position, 0);
  const s3 = state.setPlayed(s2, 'p', 'e', false, T0);
  assert.equal(state.getEpisodeState(s3, 'p', 'e').played, false);
  const bad = state.savePosition(s0, 'p', 'e', { position: -5, duration: 'abc' }, T0);
  assert.equal(state.getEpisodeState(bad, 'p', 'e').position, 0);
});

test('Hörzustand: normalizeState übersteht beschädigte Dateien', () => {
  assert.deepEqual(state.normalizeState(null), state.createState());
  assert.deepEqual(state.normalizeState('x'), state.createState());
  const raw = {
    episodes: { 'p|e': { position: 5, duration: 10, played: true, updatedAt: 'kein datum' }, kaputt: { position: 1 }, 'p|f': 'x', '|g': {} },
    feeds: { p: { etag: 'abc', lastChecked: 7 }, q: null },
  };
  const s = state.normalizeState(raw);
  assert.deepEqual(Object.keys(s.episodes), ['p|e']);
  assert.equal(s.episodes['p|e'].updatedAt, null);
  assert.equal(s.feeds.p.etag, 'abc');
  assert.equal(s.feeds.p.lastChecked, null);
  assert.equal(s.feeds.q, undefined);
});

test('Aufräumen: nur Einträge >12 Monate, die nicht mehr im Feed stehen; Metadaten ohne Abo entfallen', () => {
  const old = new Date('2025-09-01T00:00:00Z');
  const recent = new Date('2026-09-01T00:00:00Z');
  let s = state.createState();
  s = state.savePosition(s, 'p', 'alt-weg', { position: 5, duration: 100 }, old);
  s = state.savePosition(s, 'p', 'alt-im-feed', { position: 5, duration: 100 }, old);
  s = state.savePosition(s, 'p', 'neu-weg', { position: 5, duration: 100 }, recent);
  s = state.setFeedMeta(s, 'p', { etag: 'x' });
  s = state.setFeedMeta(s, 'ohne-abo', { etag: 'y' });
  const pruned = state.pruneState(s, { now: T0, isKnownEpisode: (p, e) => e === 'alt-im-feed', hasSubscription: id => id === 'p' });
  assert.deepEqual(Object.keys(pruned.episodes).sort(), ['p|alt-im-feed', 'p|neu-weg']);
  assert.deepEqual(Object.keys(pruned.feeds), ['p']);
  assert.equal(state.pruneState(pruned, { now: T0, isKnownEpisode: () => true }), pruned, 'ohne Änderung dasselbe Objekt');
});

test('migrateIds: Zustände und Metadaten wandern auf die neue Abo-ID (Validatoren werden verworfen)', () => {
  let s = state.createState();
  s = state.savePosition(s, 'alt', 'e1', { position: 5, duration: 100 }, T0);
  s = state.setFeedMeta(s, 'alt', { etag: 'x', lastChecked: T0.toISOString() });
  const moved = state.migrateIds(s, { alt: 'neu' });
  assert.deepEqual(Object.keys(moved.episodes), ['neu|e1']);
  assert.equal(moved.feeds.neu.etag, null);
  assert.equal(moved.feeds.neu.lastChecked, T0.toISOString());
  assert.equal(state.migrateIds(s, {}), s);
});

test('PodcastLibrary: Abos, Reihenfolge, Overrides, idempotentes Abonnieren, Persistenz', () => {
  const { storage } = tmpStorage();
  const library = new PodcastLibrary({ userStorage: storage, now: () => T0 });
  assert.deepEqual(library.getSubscriptions(), []);
  const a = library.subscribe({ feedUrl: 'https://a.test/feed', title: 'A', source: 'eigene-podcasts' });
  const b = library.subscribe({ feedUrl: 'https://b.test/feed', title: 'B', source: 'suche', author: 'X' });
  assert.equal(a.added, true);
  assert.equal(a.subscription.id, podcastIdFromFeedUrl('https://a.test/feed'));
  assert.equal(a.subscription.addedAt, T0.toISOString());
  assert.equal(library.subscribe({ feedUrl: 'HTTPS://A.test/feed', title: 'Anders', source: 'suche' }).added, false);
  assert.deepEqual(library.getSubscriptions().map(s => s.title), ['A', 'B']);
  library.setRank([b.subscription.id, 'unbekannt', a.subscription.id, b.subscription.id]);
  assert.deepEqual(library.getSubscriptions().map(s => s.title), ['B', 'A']);
  library.setOverride(a.subscription.id, { title: 'Mein A', cover: 'https://a.test/c.png' });
  assert.equal(library.getSubscription(a.subscription.id).title, 'Mein A');
  assert.equal(library.getSubscription(a.subscription.id).cover, 'https://a.test/c.png');
  library.setOverride(a.subscription.id, { title: '' });
  assert.equal(library.getSubscription(a.subscription.id).title, 'A');
  assert.throws(() => library.setOverride('nix', { title: 'x' }), /nicht gefunden/);
  // neue Instanz liest dieselben Dateien
  const again = new PodcastLibrary({ userStorage: storage });
  assert.deepEqual(again.getSubscriptions().map(s => s.id), [b.subscription.id, a.subscription.id]);
  assert.equal(again.unsubscribe(b.subscription.id), true);
  assert.equal(again.unsubscribe(b.subscription.id), false);
  assert.deepEqual(again.getSubscriptions().map(s => s.title), ['A']);
});

test('PodcastLibrary: Episoden-Cache max. 50 mit Hörzustand, Aufräumen entfernt Cache/Metadaten entfernter Abos', () => {
  const { storage } = tmpStorage();
  const library = new PodcastLibrary({ userStorage: storage, now: () => T0 });
  const { subscription } = library.subscribe({ feedUrl: 'https://a.test/feed', title: 'A', source: 'eigene-podcasts' });
  const episodes = Array.from({ length: 80 }, (_, i) => ({ id: `e${i}`, title: `E${i}`, duration: 600 }));
  library.setEpisodes(subscription.id, { episodes, channel: { title: 'A' } });
  library.savePosition(subscription.id, 'e3', { position: 120 });
  const listed = library.getEpisodes(subscription.id);
  assert.equal(listed.episodes.length, 50);
  assert.deepEqual(listed.episodes[3].state, { position: 120, duration: 600, played: false, updatedAt: T0.toISOString() });
  assert.equal(listed.episodes[0].state.played, false);
  library.setFeedMeta(subscription.id, { etag: 'abc' });
  assert.equal(library.getFeedMeta(subscription.id).etag, 'abc');
  library.unsubscribe(subscription.id);
  assert.deepEqual(library.getEpisodes(subscription.id).episodes, []);
  assert.equal(library.getEpisodeState(subscription.id, 'e3').position, 120, 'Hörzustand überlebt das Abo (erneutes Abonnieren setzt fort)');
  library.prune();
  assert.equal(library.getState().feeds[subscription.id], undefined);
});

test('PodcastLibrary: fillFromChannel ergänzt nur Platzhalter bei eigenen Feeds, nicht Katalog-Abos', () => {
  const { storage } = tmpStorage();
  const library = new PodcastLibrary({ userStorage: storage });
  const own = library.subscribe({ feedUrl: 'https://own.test/feed', source: 'eigene-podcasts' }).subscription;
  assert.equal(own.title, 'https://own.test/feed');
  library.fillFromChannel(own.id, { title: 'Echter Titel', author: 'Autor', cover: 'https://own.test/c.jpg' });
  assert.deepEqual([library.getSubscription(own.id).title, library.getSubscription(own.id).author], ['Echter Titel', 'Autor']);
  const cat = library.subscribe({ feedUrl: 'https://cat.test/feed', title: 'Katalog', source: 'oeffentlich-rechtlich', catalogId: 'cat-1' }).subscription;
  library.fillFromChannel(cat.id, { title: 'Anders', author: 'X', cover: 'https://x.test/c' });
  assert.equal(library.getSubscription(cat.id).title, 'Katalog');
});

test('PodcastLibrary: beschädigte Dateien werden wie leer behandelt und nicht geworfen', () => {
  const { storage, userDataPath } = tmpStorage();
  fs.mkdirSync(userDataPath, { recursive: true });
  for (const name of ['podcasts.json', 'podcast-state.json', 'podcast-episodes.json']) fs.writeFileSync(path.join(userDataPath, name), '{kaputt');
  const warnings = [];
  const library = new PodcastLibrary({ userStorage: storage, logger: { warn: (...a) => warnings.push(a.join(' ')) } });
  assert.deepEqual(library.getSubscriptions(), []);
  assert.deepEqual(library.getState(), state.createState());
  assert.deepEqual(library.getEpisodes('x').episodes, []);
  assert.ok(warnings.length >= 3);
  fs.writeFileSync(path.join(userDataPath, 'podcasts.json'), JSON.stringify({ subscriptions: [null, 5, { id: 'x' }, { id: 'ok', feedUrl: 'https://a.test/f', title: 'T' }] }));
  assert.deepEqual(library.getSubscriptions().map(s => s.id), ['ok']);
});

test('mitgelieferte Liste podcastsources.json: gültig, eindeutig, Quelle oeffentlich-rechtlich', () => {
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'podcastsources.json'), 'utf8'));
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'oeffentlich-rechtlich');
  assert.equal(list[0].type, 'bundled');
  const podcasts = list[0].podcasts;
  assert.ok(podcasts.length >= 30 && podcasts.length <= 60, `Anzahl ${podcasts.length}`);
  assert.equal(new Set(podcasts.map(p => p.id)).size, podcasts.length, 'IDs eindeutig');
  assert.equal(new Set(podcasts.map(p => podcastIdFromFeedUrl(p.feedUrl))).size, podcasts.length, 'Feed-URLs eindeutig');
  for (const p of podcasts) {
    assert.equal(podcastFeedUrlError(p.feedUrl), null, p.id);
    assert.ok(p.name, p.id);
    if (p.cover) assert.equal(podcastFeedUrlError(p.cover), null, p.id);
  }
  const { storage } = tmpStorage({ 'podcastsources.json': list });
  assert.equal(new PodcastLibrary({ userStorage: storage }).getCatalog()[0].podcasts.length, podcasts.length, 'ohne Nutzerkopie gilt der Paketstand');
});

const catalog = podcasts => [{ id: 'oeffentlich-rechtlich', name: 'ÖR', type: 'bundled', podcasts }];
const entry = (id, feedUrl, name = id) => ({ id, name, author: 'Autor', feedUrl, cover: null, genre: '' });

test('Katalog-Abgleich: geänderte Feed-URL migriert ID, Reihenfolge und Overrides; Eigene bleiben', () => {
  const oldId = podcastIdFromFeedUrl('https://old.test/feed');
  const ownId = podcastIdFromFeedUrl('https://own.test/feed');
  const data = {
    subscriptions: [
      { id: ownId, feedUrl: 'https://own.test/feed', title: 'Eigen', source: 'eigene-podcasts' },
      { id: oldId, feedUrl: 'https://old.test/feed', title: 'Alt', source: 'oeffentlich-rechtlich', catalogId: 'a' },
    ],
    subscriptionRank: [oldId, ownId],
    overrides: { [oldId]: { title: 'Mein Name' } },
  };
  const result = reconcileSubscriptions(data, catalog([entry('a', 'https://new.test/feed', 'Neu')]));
  const newId = podcastIdFromFeedUrl('https://new.test/feed');
  assert.equal(result.changed, true);
  assert.deepEqual(result.idMap, { [oldId]: newId });
  assert.deepEqual(result.data.subscriptionRank, [newId, ownId]);
  assert.deepEqual(result.data.overrides, { [newId]: { title: 'Mein Name' } });
  const migrated = result.data.subscriptions.find(s => s.id === newId);
  assert.equal(migrated.feedUrl, 'https://new.test/feed');
  assert.equal(migrated.title, 'Neu');
  assert.equal(result.data.subscriptions.find(s => s.id === ownId).title, 'Eigen');
  const again = reconcileSubscriptions(result.data, catalog([entry('a', 'https://new.test/feed', 'Neu')]));
  assert.equal(again.changed, false, 'idempotent');
  assert.deepEqual(data.subscriptionRank, [oldId, ownId], 'Eingabe bleibt unverändert');
});

test('Katalog-Abgleich: entfernter Eintrag bleibt als removed, kehrt er zurück, verschwindet die Markierung', () => {
  const id = podcastIdFromFeedUrl('https://a.test/feed');
  const data = { subscriptions: [{ id, feedUrl: 'https://a.test/feed', title: 'A', source: 'oeffentlich-rechtlich', catalogId: 'a' }], subscriptionRank: [id], overrides: {} };
  const gone = reconcileSubscriptions(data, catalog([entry('b', 'https://b.test/feed')]));
  assert.equal(gone.data.subscriptions[0].removed, true);
  assert.deepEqual(gone.idMap, {});
  const back = reconcileSubscriptions(gone.data, catalog([entry('a', 'https://a.test/feed', 'A')]));
  assert.equal('removed' in back.data.subscriptions[0], false);
  const collision = reconcileSubscriptions(
    { subscriptions: [...data.subscriptions, { id: podcastIdFromFeedUrl('https://b.test/feed'), feedUrl: 'https://b.test/feed', title: 'B', source: 'suche' }], subscriptionRank: [], overrides: {} },
    catalog([entry('a', 'https://b.test/feed')])
  );
  assert.equal(collision.data.subscriptions.length, 1, 'zwei Abos auf dieselbe URL werden zusammengeführt');
});

test('reconcilePodcastSources: schreibt Abos und Hörstatus, ohne Abos nichts zu tun, kaputte Dateien bleiben unangetastet', () => {
  const { root, bundlePath } = tmpStorage();
  const bundleFile = path.join(bundlePath, 'podcastsources.json');
  const podcastsFile = path.join(root, 'podcasts.json');
  const stateFile = path.join(root, 'podcast-state.json');
  fs.writeFileSync(bundleFile, JSON.stringify(catalog([entry('a', 'https://new.test/feed')])));
  assert.equal(reconcilePodcastSources({ podcastsFile, stateFile, bundleFile }).merged, false, 'keine Abos');
  const oldId = podcastIdFromFeedUrl('https://old.test/feed');
  fs.writeFileSync(podcastsFile, JSON.stringify({ subscriptions: [{ id: oldId, feedUrl: 'https://old.test/feed', title: 'Alt', source: 'oeffentlich-rechtlich', catalogId: 'a' }], subscriptionRank: [oldId], overrides: {} }));
  fs.writeFileSync(stateFile, JSON.stringify(state.savePosition(state.createState(), oldId, 'e1', { position: 50, duration: 100 }, T0)));
  const result = reconcilePodcastSources({ podcastsFile, stateFile, bundleFile });
  assert.equal(result.merged, true);
  const newId = podcastIdFromFeedUrl('https://new.test/feed');
  assert.equal(JSON.parse(fs.readFileSync(podcastsFile, 'utf8')).subscriptions[0].id, newId);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).episodes[`${newId}|e1`].position, 50);
  assert.equal(reconcilePodcastSources({ podcastsFile, stateFile, bundleFile }).merged, false, 'idempotent');
  fs.writeFileSync(podcastsFile, '{kaputt');
  assert.equal(reconcilePodcastSources({ podcastsFile, stateFile, bundleFile }).merged, false);
  assert.equal(fs.readFileSync(podcastsFile, 'utf8'), '{kaputt');
});

test('normalizeState verwirft Prototyp-Schlüssel in feeds', () => {
  const raw = JSON.parse('{"feeds":{"__proto__":{"lastChecked":"2026-10-15T10:00:00Z"},"constructor":{"etag":"x"},"abc":{"etag":"y"}}}');
  const normalized = state.normalizeState(raw);
  assert.deepEqual(Object.keys(normalized.feeds), ['abc']);
  assert.equal(Object.getPrototypeOf(normalized.feeds), Object.prototype);
  assert.equal(normalized.feeds.lastChecked, undefined);
});

test('Backup-Import bereinigt Podcast-Overrides', () => {
  const { validateBackup } = require('../lib/backup.js');
  const feedUrl = 'https://example.test/feed.xml';
  const id = podcastIdFromFeedUrl(feedUrl);
  const overrides = JSON.parse(
    `{"${id}":{"title":"Neu","cover":"https://user:pw@example.test/c.png"},"__proto__":{"title":"x"},"kein-id!":{"title":"y"},"abcdef":{"title":123,"cover":"javascript:alert(1)"},"abc123":{"title":"${'t'.repeat(301)}"}}`,
  );
  const data = { services: [], tvsources: [], podcasts: { subscriptions: [{ id, feedUrl, title: 'P' }], overrides } };
  const result = validateBackup(data);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.podcasts.overrides, { [id]: { title: 'Neu' } });
});

test('applyOverride ignoriert ungültige Felder defensiv', () => {
  const library = new PodcastLibrary({ userStorage: tmpStorage().storage });
  const sub = { id: 'a1', title: 'Orig', cover: 'https://example.test/o.png' };
  assert.deepEqual(library.applyOverride(sub, { title: { x: 1 }, cover: 'file:///etc/passwd' }), sub);
  assert.equal(library.applyOverride(sub, { title: 'Neu' }).title, 'Neu');
});
