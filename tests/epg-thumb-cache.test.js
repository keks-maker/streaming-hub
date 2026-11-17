'use strict';

// Tests: EPG-Vorschaubilder (Jetzt & Gleich, Detail-Poster) laden über den Main-Bild-Cache; fremde, private und
// Loopback-Adressen kommen nie als img.src im DOM an.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeDoc } = require('./helpers/fake-dom.js');

global.document = makeDoc();
const { setCellThumb, cachedImageSrc } = require('../epg-row-dom.js');

const DATA = 'data:image/png;base64,AAAA';
const tick = () => new Promise(resolve => setImmediate(resolve));

function makeEntry() {
  const box = global.document.createElement('span');
  box.querySelector = () => box.children.find(c => c.tagName === 'img') || null;
  return { box, entry: { refs: { thumb: box } } };
}
const imgs = box => box.children.filter(c => c.tagName === 'img');

test('setCellThumb: private und Loopback-Adressen werden nie als img.src gesetzt (Cache liefert null)', async () => {
  const urls = ['https://192.168.1.1/a.png', 'https://127.0.0.1:9/b.png', 'https://localhost/c.png', 'https://10.0.0.5/d.png', 'https://[::1]/e.png'];
  for (const url of urls) {
    const { box, entry } = makeEntry();
    const asked = [];
    setCellThumb(entry, url, async u => (asked.push(u), null), 0);
    await tick();
    assert.equal(imgs(box).length, 0, url);
    assert.ok(!box.children.some(c => c.src === url), url);
    assert.ok(asked.length <= 1);
  }
});

test('setCellThumb: auch ein fehlerhafter Loader oder eine Fremd-URL als Antwort ergibt kein img', async () => {
  for (const reply of [Promise.reject(new Error('x')), Promise.resolve('https://192.168.1.1/a.png'), Promise.resolve('javascript:1'), Promise.resolve('')]) {
    const { box, entry } = makeEntry();
    setCellThumb(entry, 'https://img.example.org/a.png', () => reply, 0);
    await tick();
    assert.equal(imgs(box).length, 0);
  }
});

test('setCellThumb: ohne Loader kein Bild; data:-Antwort des Caches wird gesetzt, einmalig', async () => {
  const a = makeEntry();
  assert.equal(setCellThumb(a.entry, 'https://img.example.org/a.png'), false);
  const { box, entry } = makeEntry();
  let calls = 0;
  const loader = async () => (calls += 1, DATA);
  assert.equal(setCellThumb(entry, 'https://img.example.org/a.png', loader, 5), true);
  setCellThumb(entry, 'https://img.example.org/a.png', loader, 5);
  await tick();
  assert.equal(calls, 1);
  assert.equal(imgs(box).length, 1);
  assert.equal(imgs(box)[0].src, DATA);
});

test('cachedImageSrc: nur data:image/…;base64', () => {
  assert.equal(cachedImageSrc(DATA), DATA);
  for (const bad of ['https://a/b.png', 'data:text/html;base64,AA', 'javascript:1', '', null, 5]) assert.equal(cachedImageSrc(bad), '');
});

test('Verdrahtung: Detail-Poster und J&G laden über getImage, kein direktes img.src mit Fremd-URL', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('epg-view.js'), /api\.getEpgImage\(url, stopMs\)/);
  assert.match(read('epg-detail-view.js'), /deps\.getImage\(url/);
  assert.match(read('epg-jng-view.js'), /setCellThumb\(cell, url, deps\.getImage/);
  assert.ok(!/img\.src = (url|safe)\b/.test(read('epg-detail-view.js') + read('epg-row-dom.js')));
});
