'use strict';

// Tests: YouTube-URL-Klassifizierung (Video / Stöbern / extern), Video-IDs, Vorschaubild.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyYoutubeUrl, isVideoId, watchUrl, thumbnailUrl } = require('../lib/youtube-url.js');

const ID = 'dQw4w9WgXcQ';

test('Video-Adressen: watch, youtu.be, live → kanonische Adresse ohne Zusatzparameter', () => {
  const expected = { kind: 'watch', url: `https://www.youtube.com/watch?v=${ID}`, videoId: ID };
  for (const url of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s&list=PL123`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}?si=abc`,
    `https://www.youtube.com/live/${ID}?feature=share`,
    `http://www.youtube.com/watch?v=${ID}`,
  ]) {
    assert.deepEqual(classifyYoutubeUrl(url), expected, url);
  }
});

test('Stöbern: alle anderen YouTube-Seiten, auch Shorts und watch ohne gültige ID', () => {
  for (const url of [
    'https://www.youtube.com/',
    'https://www.youtube.com/results?search_query=musik',
    'https://www.youtube.com/@kanal/videos',
    'https://www.youtube.com/feed/subscriptions',
    `https://www.youtube.com/shorts/${ID}`,
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=zu-kurz',
    'https://consent.youtube.com/m?continue=x',
  ]) {
    assert.equal(classifyYoutubeUrl(url).kind, 'browse', url);
  }
});

test('Extern oder ungültig: fremde Hosts (auch ähnlich klingende), youtube-nocookie, Nicht-http-Schemata', () => {
  for (const url of [
    'https://example.org/watch?v=' + ID,
    'https://youtube.com.evil.example/watch?v=' + ID,
    'https://notyoutube.com/watch?v=' + ID,
    'https://www.youtube-nocookie.com/embed/' + ID,
    'https://youtu.be.evil.example/' + ID,
    'https://youtu.be/zu-kurz',
  ]) {
    assert.equal(classifyYoutubeUrl(url).kind, 'external', url);
  }
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', '', null, undefined, 42, 'kaputt']) {
    assert.equal(classifyYoutubeUrl(url).kind, 'invalid', String(url));
  }
});

test('Video-ID: genau 11 Zeichen aus A-Z a-z 0-9 _ -; watchUrl und Vorschaubild verlangen eine gültige ID', () => {
  assert.equal(isVideoId(ID), true);
  for (const bad of ['', 'abc', ID + 'x', 'dQw4w9WgXc!', 'dQw4w9WgXc ', null, 12345678901, undefined]) assert.equal(isVideoId(bad), false, String(bad));
  assert.equal(watchUrl(ID), `https://www.youtube.com/watch?v=${ID}`);
  assert.throws(() => watchUrl('x'), /Ungültige Video-ID/);
  assert.equal(thumbnailUrl(ID), `https://i.ytimg.com/vi/${ID}/mqdefault.jpg`);
  assert.equal(thumbnailUrl('x'), '');
});
