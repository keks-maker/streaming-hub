'use strict';

// Tests: YouTube-Playlist (Validierung, Reihenfolge, „nächstes am Ende“, Grenzen) und die IPC-Validierung dazu.

const test = require('node:test');
const assert = require('node:assert/strict');
const pl = require('../lib/youtube-playlist.js');
const { validateYoutubePlaylist, validateYoutubeMiniPatch, validateYoutubeVideoRef, validateWebContentsId } = require('../lib/ipc-validation.js');
const { normalizeYoutubeMiniSettings } = require('../lib/youtube-mini-settings.js');

const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const C = 'ccccccccccc';
const D = 'ddddddddddd';
const e = (id, title = '') => ({ id, title });

test('Normalisierung: nur gültige Video-IDs, Titel als bereinigter Text, Doppelte entfallen, nur id und title bleiben', () => {
  const list = pl.normalizePlaylist([
    { id: A, title: '  Erstes\nVideo\t', extra: 'x', url: 'javascript:alert(1)' },
    { id: 'kaputt', title: 'x' },
    { id: A, title: 'Doppelt' },
    { id: B, title: 42 },
    null,
    'text',
    { id: C },
  ]);
  assert.deepEqual(list, [e(A, 'Erstes Video'), e(B, ''), e(C, '')]);
  assert.deepEqual(pl.normalizePlaylist({ version: 1, items: [e(A, 'x')] }), [e(A, 'x')]);
  for (const bad of [null, undefined, 'text', 5, {}]) assert.deepEqual(pl.normalizePlaylist(bad), []);
});

test('Grenzen: Titel höchstens 200 Zeichen, höchstens 200 Einträge', () => {
  assert.equal(pl.normalizeEntry({ id: A, title: 'x'.repeat(500) }).title.length, pl.MAX_TITLE_LENGTH);
  const many = Array.from({ length: 300 }, (_, i) => e(String(i).padStart(11, 'z')));
  assert.equal(pl.normalizePlaylist(many).length, pl.MAX_ENTRIES);
  const full = pl.normalizePlaylist(many);
  assert.equal(pl.addEntry(full, e(A)), full);
});

test('Hinzufügen: hinten, ohne Doppelte; „Als Nächstes“ an den Anfang, vorhandener Eintrag rückt nach vorn', () => {
  let list = pl.addEntry([], e(A, 'a'));
  list = pl.addEntry(list, e(B));
  assert.deepEqual(list.map(x => x.id), [A, B]);
  assert.equal(pl.addEntry(list, e(A)), list);
  assert.equal(pl.addEntry(list, { id: 'kaputt' }), list);
  assert.deepEqual(pl.addNext(list, e(C)).map(x => x.id), [C, A, B]);
  assert.deepEqual(pl.addNext(list, e(B)).map(x => x.id), [B, A]);
});

test('Reihenfolge: Ziehen auf eine Zeile, ▲▼ mit Randbegrenzung, Entfernen', () => {
  const list = [e(A), e(B), e(C), e(D)];
  assert.deepEqual(pl.moveToTarget(list, D, A).map(x => x.id), [D, A, B, C]);
  assert.deepEqual(pl.moveToTarget(list, A, C).map(x => x.id), [B, C, A, D]);
  assert.equal(pl.moveToTarget(list, A, A), list);
  assert.equal(pl.moveToTarget(list, A, 'unbekannt0'), list);
  assert.deepEqual(pl.moveBy(list, B, -1).map(x => x.id), [B, A, C, D]);
  assert.deepEqual(pl.moveBy(list, D, 5).map(x => x.id), [A, B, C, D]);
  assert.equal(pl.moveBy(list, A, -1), list);
  assert.deepEqual(pl.removeEntry(list, B).map(x => x.id), [A, C, D]);
  assert.equal(pl.removeEntry(list, 'unbekannt0'), list);
});

test('Videoende: nächster Eintrag kommt aus der Liste und verlässt sie; leere Liste liefert keinen', () => {
  const list = [e(A, 'a'), e(B)];
  const first = pl.takeFirst(list);
  assert.deepEqual(first.next, e(A, 'a'));
  assert.deepEqual(first.rest.map(x => x.id), [B]);
  assert.equal(pl.takeFirst(first.rest).next.id, B);
  assert.deepEqual(pl.takeFirst([]), { next: null, rest: [] });
  const picked = pl.takeEntry(list, B);
  assert.equal(picked.next.id, B);
  assert.deepEqual(picked.rest.map(x => x.id), [A]);
  assert.equal(pl.takeEntry(list, C).next, null);
});

test('Titel nachtragen: nur bei Einträgen ohne Titel', () => {
  const list = [e(A), e(B, 'schon da')];
  assert.equal(pl.withTitle(list, A, ' Neu ')[0].title, 'Neu');
  assert.equal(pl.withTitle(list, B, 'anders'), list);
  assert.equal(pl.withTitle(list, A, ''), list);
});

test('IPC-Validierung der Playlist: nur Array aus { id, title? }, Normalisierung beim Speichern', () => {
  assert.deepEqual(validateYoutubePlaylist([{ id: A, title: 'x\u0000y' }]), [e(A, 'x y')]);
  for (const bad of [null, {}, 'x', [{ id: 'kaputt' }], [null], [{ id: A, title: 5 }], Array.from({ length: 201 }, () => e(A))]) {
    assert.throws(() => validateYoutubePlaylist(bad), /Ungültige Playlist/);
  }
  assert.deepEqual(validateYoutubeVideoRef({ id: A, title: 'T' }), e(A, 'T'));
  assert.throws(() => validateYoutubeVideoRef({ id: 'x' }), /Ungültiges Video/);
  assert.throws(() => validateYoutubeVideoRef(null), /Ungültiges Video/);
  assert.equal(validateWebContentsId(7), 7);
  for (const bad of [0, -1, 1.5, '3', null, NaN]) assert.throws(() => validateWebContentsId(bad), /Webview-Kennung/);
});

test('Einstellungen: Standard an/ersetzen, Patch nur enabled und clickBehavior mit gültigen Werten', () => {
  assert.deepEqual(normalizeYoutubeMiniSettings(null), { enabled: true, clickBehavior: 'replace' });
  assert.deepEqual(normalizeYoutubeMiniSettings({ enabled: false, clickBehavior: 'playlist' }), { enabled: false, clickBehavior: 'playlist' });
  assert.deepEqual(normalizeYoutubeMiniSettings({ enabled: 'ja', clickBehavior: 'x' }), { enabled: true, clickBehavior: 'replace' });
  assert.deepEqual(validateYoutubeMiniPatch({ enabled: false }), { enabled: false });
  assert.deepEqual(validateYoutubeMiniPatch({ clickBehavior: 'playlist' }), { clickBehavior: 'playlist' });
  for (const bad of [null, [], {}, { enabled: 1 }, { clickBehavior: 'x' }, { enabled: true, extra: 1 }]) {
    assert.throws(() => validateYoutubeMiniPatch(bad), /Ungültige Mini-Player-Einstellungen/);
  }
});
