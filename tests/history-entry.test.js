'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeHistoryUrl, sanitizeHistoryEntry, hostBelongsToService } = require('../lib/history-entry.js');
const { parseBackup } = require('../lib/backup.js');

test('sanitizeHistoryUrl: Query und Fragment entfallen, Pfad bleibt', () => {
  assert.equal(sanitizeHistoryUrl('https://www.netflix.com/watch/123?trackId=9&sessionid=abc#frag'), 'https://www.netflix.com/watch/123');
  assert.equal(sanitizeHistoryUrl('https://user:pw@www.netflix.com/title/5?x=1'), 'https://www.netflix.com/title/5');
});

test('sanitizeHistoryUrl: YouTube behält v, list und t, alles andere fällt weg', () => {
  assert.equal(sanitizeHistoryUrl('https://www.youtube.com/watch?v=abc&si=TRACK&list=PL1&t=42s&utm_source=x#c'), 'https://www.youtube.com/watch?v=abc&list=PL1&t=42s');
  assert.equal(sanitizeHistoryUrl('https://youtu.be/abc?si=TRACK&t=5'), 'https://www.youtube.com/watch?v=abc&t=5');
});

test('sanitizeHistoryUrl: ungültige Schemas und Längen ergeben leer', () => {
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'x', '', null, 5, `https://a.de/${'a'.repeat(2100)}`]) assert.equal(sanitizeHistoryUrl(bad), '');
});

test('sanitizeHistoryEntry: ungültige url wird weggelassen, übrige Felder bleiben', () => {
  assert.deepEqual(sanitizeHistoryEntry({ title: 'A', serviceKey: 'k', url: 'javascript:1' }), { title: 'A', serviceKey: 'k' });
  assert.deepEqual(sanitizeHistoryEntry({ title: 'A', url: 'https://a.de/x?t=1' }), { title: 'A', url: 'https://a.de/x' });
  assert.equal(sanitizeHistoryEntry(null), null);
});

test('Backup-Import bereinigt url in Verlaufseinträgen', () => {
  const raw = JSON.stringify({
    services: [{ id: 'yt', name: 'YouTube', url: 'https://www.youtube.com' }, { id: 'k', name: 'K', url: 'https://k.example' }], tvsources: [],
    history: [
      { title: 'A', serviceKey: 'yt', url: 'https://www.youtube.com/watch?v=1&si=x' },
      { title: 'B', serviceKey: 'k', url: 'file:///etc/passwd' },
    ],
  });
  const { history } = parseBackup(raw);
  assert.equal(history[0].url, 'https://www.youtube.com/watch?v=1');
  assert.equal('url' in history[1], false);
});

test('youtu.be/<id> wird zu youtube.com/watch?v=<id> und gehört zum Dienst YouTube', () => {
  const url = sanitizeHistoryUrl('https://youtu.be/abc123?si=TRACK&t=5');
  assert.equal(url, 'https://www.youtube.com/watch?v=abc123&t=5');
  assert.equal(hostBelongsToService(url, 'https://www.youtube.com'), true);
  assert.equal(hostBelongsToService('https://youtu.be/abc', 'https://www.youtube.com'), true);
});

test('Prime: amazon.de gehört zum Dienst primevideo.com, aber nicht zu Netflix', () => {
  assert.equal(hostBelongsToService('https://www.amazon.de/gp/video/detail/X', 'https://www.primevideo.com'), true);
  assert.equal(hostBelongsToService('https://www.amazon.de/gp/video/detail/X', 'https://www.netflix.com'), false);
  assert.equal(hostBelongsToService('https://evilamazon.de/', 'https://www.primevideo.com'), false);
});

test('Nicht-Standard-Port wird abgelehnt, Port der Dienst-URL bleibt erlaubt', () => {
  assert.equal(hostBelongsToService('https://www.netflix.com:8443/x', 'https://www.netflix.com'), false);
  assert.equal(hostBelongsToService('http://localhost:5000/x', 'http://localhost:5000/home'), true);
  assert.equal(hostBelongsToService('http://localhost:5001/x', 'http://localhost:5000/home'), false);
});

test('Länge wird nach der Bereinigung geprüft', () => {
  assert.equal(sanitizeHistoryUrl(`https://a.de/x?${'q=1&'.repeat(700)}`), 'https://a.de/x');
  assert.equal(sanitizeHistoryUrl(`https://a.de/${'a'.repeat(2100)}`), '');
});

test('Backup-Import: dienstfremde URLs und Nicht-Objekte entfallen schon beim Import', () => {
  const raw = JSON.stringify({
    services: [{ id: 'nf', name: 'Netflix', url: 'https://www.netflix.com' }],
    tvsources: [],
    history: [
      { title: 'A', serviceKey: 'nf', url: 'https://www.netflix.com/watch/1?x=1' },
      { title: 'B', serviceKey: 'nf', url: 'https://evil.example/phish' },
      { title: 'C', serviceKey: 'unbekannt', url: 'https://www.netflix.com/watch/2' },
      'text', null, 5,
    ],
  });
  const { history } = parseBackup(raw);
  assert.equal(history.length, 3);
  assert.equal(history[0].url, 'https://www.netflix.com/watch/1');
  assert.equal('url' in history[1], false);
  assert.equal('url' in history[2], false);
});
