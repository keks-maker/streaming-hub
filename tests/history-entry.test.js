'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeHistoryUrl, sanitizeHistoryEntry } = require('../lib/history-entry.js');
const { parseBackup } = require('../lib/backup.js');

test('sanitizeHistoryUrl: Query und Fragment entfallen, Pfad bleibt', () => {
  assert.equal(sanitizeHistoryUrl('https://www.netflix.com/watch/123?trackId=9&sessionid=abc#frag'), 'https://www.netflix.com/watch/123');
  assert.equal(sanitizeHistoryUrl('https://user:pw@www.netflix.com/title/5?x=1'), 'https://www.netflix.com/title/5');
});

test('sanitizeHistoryUrl: YouTube behält v, list und t, alles andere fällt weg', () => {
  assert.equal(sanitizeHistoryUrl('https://www.youtube.com/watch?v=abc&si=TRACK&list=PL1&t=42s&utm_source=x#c'), 'https://www.youtube.com/watch?v=abc&list=PL1&t=42s');
  assert.equal(sanitizeHistoryUrl('https://youtu.be/abc?si=TRACK&t=5'), 'https://youtu.be/abc?t=5');
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
    services: [], tvsources: [],
    history: [
      { title: 'A', serviceKey: 'yt', url: 'https://www.youtube.com/watch?v=1&si=x' },
      { title: 'B', serviceKey: 'k', url: 'file:///etc/passwd' },
    ],
  });
  const { history } = parseBackup(raw);
  assert.equal(history[0].url, 'https://www.youtube.com/watch?v=1');
  assert.equal('url' in history[1], false);
});
