'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { httpUrl, parseBackup, remoteHttpUrl, service, tvSource } = {
  ...require('../lib/input-validation.js'),
  parseBackup: require('../lib/backup.js').parseBackup,
};

test('accepts HTTP(S) URLs and rejects executable schemes', () => {
  assert.equal(httpUrl('https://example.test/list.m3u', 'URL'), 'https://example.test/list.m3u');
  assert.throws(() => httpUrl('file:///etc/passwd', 'URL'), /HTTP oder HTTPS/);
  assert.throws(() => httpUrl('javascript:alert(1)', 'URL'), /HTTP oder HTTPS/);
  assert.throws(() => httpUrl('https://user:pass@example.test', 'URL'), /Zugangsdaten/);
});

test('rejects private remote targets except the configured local Gitea origin', () => {
  assert.equal(
    remoteHttpUrl('https://updates.example.invalid/releases/latest', 'URL', { allowOrigin: 'https://updates.example.invalid' }),
    'https://updates.example.invalid/releases/latest',
  );
  for (const value of ['http://127.0.0.1:8080/a', 'http://192.168.1.2/a', 'http://169.254.169.254/latest']) {
    assert.throws(() => remoteHttpUrl(value, 'URL'), /lokales oder privates Ziel/);
  }
});

test('normalizes and validates service and TV source inputs', () => {
  assert.deepEqual(service({ name: ' YouTube ', url: 'https://youtube.com', icon: 'youtube.png' }), {
    name: 'YouTube',
    url: 'https://youtube.com/',
    icon: 'youtube.png',
    color: undefined,
    group: undefined,
  });
  assert.equal(tvSource({ name: 'TV', url: 'https://example.test/a.m3u' }).url, 'https://example.test/a.m3u');
  assert.throws(() => service({ name: '<script>', url: 'file:///tmp/x' }), /Dienst-URL/);
  assert.throws(() => tvSource({ name: 'TV', url: 'file:///etc/passwd' }), /M3U-URL/);
});

test('backup parser remains available for boundary tests', () => {
  assert.throws(() => parseBackup('{}'), /services und tvsources/);
});

const iv = require('../lib/input-validation.js');
const hostOf = url => new URL(url).hostname;

test('isPrivateHostname: lokale/private Ziele (IPv4, IPv6, Namen) werden abgelehnt', () => {
  for (const url of [
    'http://0.0.0.0/x',
    'http://0.1.2.3/x',
    'http://127.0.0.1/x',
    'http://10.1.2.3/x',
    'http://172.16.0.1/x',
    'http://172.31.255.255/x',
    'http://192.168.1.1/x',
    'http://169.254.169.254/x',
    'http://[::1]/x',
    'http://[::]/x',
    'http://[::ffff:127.0.0.1]/x',
    'http://[::ffff:10.0.0.1]/x',
    'http://[::ffff:c0a8:101]/x',
    'http://[fd00::1]/x',
    'http://[fc00::1]/x',
    'http://[fe80::1]/x',
    'http://[64:ff9b::7f00:1]/x',
    'http://[2002:c0a8:101::]/x',
    'http://localhost/x',
    'http://tv.localhost/x',
    'http://nas.local/x',
    'http://printer.lan/x',
    'http://x.internal/x',
    'http://x.home.arpa/x',
    'http://x.localdomain/x',
    'http://intranet/x',
    'http://0x7f.0.0.1/x',
    'http://2130706433/x',
    'http://017700000001/x',
    'http://127.1/x',
  ]) {
    assert.equal(iv.isPrivateHostname(hostOf(url)), true, url);
    assert.throws(() => remoteHttpUrl(url, 'URL'), /lokales oder privates Ziel/, url);
  }
});

test('isPrivateHostname: öffentliche Ziele bleiben erlaubt', () => {
  for (const url of [
    'https://example.com/a.m3u',
    'https://iptv-org.github.io/iptv/countries/de.m3u',
    'https://zdf-hls-15.akamaized.net/hls/live/x.m3u8',
    'http://8.8.8.8/x',
    'http://1.1.1.1/x',
    'http://172.32.0.1/x',
    'http://172.15.0.1/x',
    'http://[2001:4860:4860::8888]/x',
    'http://[2606:4700:4700::1111]/x',
    'http://[::ffff:8.8.8.8]/x',
  ]) {
    assert.equal(iv.isPrivateHostname(hostOf(url)), false, url);
    assert.doesNotThrow(() => remoteHttpUrl(url, 'URL'), url);
  }
});

test('Logo-Validierung: relative Pfade ok, Netzwerk-/UNC-/Fremdschemata abgelehnt', () => {
  for (const ok of ['logos/a.png', 'a.png', '/logos/a.png', 'https://cdn.example.com/a.png', 'http://cdn.example.com/a.png']) {
    assert.equal(iv.channelLogoError(ok), null, ok);
  }
  for (const bad of [
    '//evil.example/x.png',
    '\\\\host\\share\\x.png',
    'logos\\a.png',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'ftp://x.example/a.png',
    'https://',
    'a b.png',
    '',
  ]) {
    assert.ok(iv.channelLogoError(bad), JSON.stringify(bad));
  }
});

test('Stream-URL-Override: nur öffentliche http(s)-Ziele ohne Zugangsdaten', () => {
  assert.equal(iv.channelStreamUrlError('https://stream.example.com/live.m3u8'), null);
  for (const bad of ['http://user:pw@stream.example.com/a', 'ftp://x.example/a', 'kein url', 'http://[::ffff:127.0.0.1]/a', 'http://intranet/a']) {
    assert.ok(iv.channelStreamUrlError(bad), bad);
  }
});

test('tvSourceUpdates validiert channelOverrides beim Schreiben (nur neue/geänderte Einträge)', () => {
  const existing = { alt: { url: 'http://192.168.0.5/legacy.m3u8', name: 'Bestand' }, c1: { name: 'X', fremdfeld: 1 } };
  // unveränderte Bestandsdaten (auch mit privater URL) werden nicht neu bewertet
  assert.doesNotThrow(() => iv.tvSourceUpdates({ channelOverrides: { ...existing, c2: { name: 'Neu' } } }, 'url', existing));
  // unbekannte Felder bleiben erlaubt
  assert.doesNotThrow(() => iv.tvSourceUpdates({ channelOverrides: { c1: { name: 'X', fremdfeld: 2 } } }, 'url', existing));
  for (const bad of [
    { c2: { url: 'http://127.0.0.1/x' } },
    { c2: { url: 'file:///etc/passwd' } },
    { c2: { url: 'http://[::ffff:127.0.0.1]/x' } },
    { c2: { url: 5 } },
    { c2: { tvgLogo: '//evil.example/x.png' } },
    { c2: { tvgLogo: 'file:///x.png' } },
    { c2: { name: 'x'.repeat(201) } },
    { c2: { tvgId: 7 } },
    { c2: 'kein objekt' },
    { c2: null },
  ]) {
    assert.throws(() => iv.tvSourceUpdates({ channelOverrides: bad }, 'url', existing), undefined, JSON.stringify(bad));
  }
  assert.throws(() => iv.tvSourceUpdates({ channelOverrides: [] }, 'url'), /Kanalüberschreibungen/);
  assert.throws(() => iv.tvSourceUpdates({ channelOverrides: null }, 'url'), /Kanalüberschreibungen/);
});

test('main.js reicht bestehende Overrides an die Update-Validierung durch', () => {
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(main.includes('sources[idx].channelOverrides'));
});

test('isPrivateHostname: weitere Bereiche (CGNAT, Benchmark, Multicast, Reserviert, SIIT, Site-Local, mehrfache Trailing-Dots)', () => {
  for (const url of [
    'http://localhost../x',
    'http://a.lan../x',
    'http://nas.local../x',
    'http://100.64.0.1/x',
    'http://100.127.255.255/x',
    'http://198.18.0.1/x',
    'http://198.19.255.255/x',
    'http://192.0.0.9/x',
    'http://224.0.0.1/x',
    'http://239.255.255.250/x',
    'http://240.0.0.1/x',
    'http://255.255.255.255/x',
    'http://[ff02::1]/x',
    'http://[fec0::1]/x',
    'http://[::ffff:0:8.8.8.8]/x',
    'http://[::ffff:0:a00:1]/x',
    'http://[64:ff9b:1::1]/x',
    'http://[64:ff9b::a00:1]/x',
    'http://[::10.0.0.1]/x',
    'http://[::2]/x',
  ]) {
    assert.equal(iv.isPrivateHostname(hostOf(url)), true, url);
  }
  // nicht auswertbare IPv6-Adressen werden sicherheitshalber abgelehnt
  for (const raw of ['1:2:3', 'g::1', '1:2:3:4:5:6:7:8:9', ':::', '1::2::3']) assert.equal(iv.isPrivateHostname(raw), true, raw);
  assert.equal(iv.isPrivateHostname(''), true);
  assert.equal(iv.isPrivateHostname('.'), true);
});

test('isPrivateHostname: öffentliche Grenzfälle bleiben erlaubt', () => {
  for (const url of [
    'http://100.63.255.255/x',
    'http://100.128.0.1/x',
    'http://198.17.255.255/x',
    'http://198.20.0.1/x',
    'http://223.255.255.255/x',
    'http://[::ffff:8.8.8.8]/x',
    'http://[64:ff9b::808:808]/x',
    'http://[2001:4860:4860::8888]/x',
    'https://example.com./x',
  ]) {
    assert.equal(iv.isPrivateHostname(hostOf(url)), false, url);
  }
});

test('Alle URLs aus services.json und tvsources.json bleiben gültig (öffentliche Ziele)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const urls = [];
  const collect = value => {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) urls.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  for (const file of ['services.json', 'tvsources.json']) {
    collect(JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8')));
  }
  assert.ok(urls.length >= 30, `erwartet viele Default-URLs, gefunden ${urls.length}`);
  for (const url of urls) {
    assert.equal(iv.isPrivateHostname(hostOf(url)), false, url);
    assert.doesNotThrow(() => remoteHttpUrl(url, 'URL'), url);
  }
});

test('channelOverrides: Bestandseintrag mit anderer Schlüsselreihenfolge gilt als unverändert', () => {
  const existing = { c1: { name: 'Alt', url: 'http://192.168.0.5/legacy.m3u8', tvgLogo: 'file:///alt.png' } };
  const reordered = { c1: { tvgLogo: 'file:///alt.png', url: 'http://192.168.0.5/legacy.m3u8', name: 'Alt' } };
  assert.doesNotThrow(() => iv.tvSourceUpdates({ channelOverrides: reordered }, 'url', existing));
  // geändertes Feld wird geprüft, unveränderte private Felder desselben Eintrags nicht
  assert.doesNotThrow(() => iv.tvSourceUpdates({ channelOverrides: { c1: { ...reordered.c1, name: 'Neu' } } }, 'url', existing));
  assert.throws(() => iv.tvSourceUpdates({ channelOverrides: { c1: { ...reordered.c1, url: 'http://127.0.0.1/x' } } }, 'url', existing), /lokales oder privates/);
  assert.throws(() => iv.tvSourceUpdates({ channelOverrides: { c1: { ...reordered.c1, tvgLogo: '//evil.example/x.png' } } }, 'url', existing), /UNC|Netzwerk/);
});

test('Stream-URL: Längenprüfung', () => {
  assert.ok(iv.channelStreamUrlError(`https://stream.example.com/${'x'.repeat(4100)}`));
  assert.equal(iv.channelStreamUrlError(`https://stream.example.com/${'x'.repeat(100)}`), null);
  assert.ok(iv.channelLogoError(`https://cdn.example.com/${'x'.repeat(4100)}`));
});
