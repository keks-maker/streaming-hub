const test = require('node:test');
const assert = require('node:assert/strict');
const { describeM3uFetchError } = require('../lib/m3u-fetch-error.js');

function fetchFailed(cause) {
  const err = new TypeError('fetch failed');
  err.cause = cause;
  return err;
}
function coded(code, message = 'x') {
  return Object.assign(new Error(message), { code });
}

test('DNS: ENOTFOUND/EAI_AGAIN -> Host nicht gefunden', () => {
  assert.match(describeM3uFetchError(fetchFailed(coded('ENOTFOUND'))), /Host nicht gefunden/);
  assert.match(describeM3uFetchError(fetchFailed(coded('EAI_AGAIN'))), /Host nicht gefunden/);
});

test('ECONNREFUSED -> Verbindung abgelehnt (auch in AggregateError)', () => {
  assert.match(describeM3uFetchError(fetchFailed(coded('ECONNREFUSED'))), /Verbindung abgelehnt/);
  const agg = new AggregateError([coded('ECONNREFUSED'), coded('ECONNREFUSED')]);
  assert.match(describeM3uFetchError(fetchFailed(agg)), /Verbindung abgelehnt/);
});

test('Zeitüberschreitung: TimeoutError, AbortError, ETIMEDOUT, undici-Timeouts', () => {
  const timeout = new globalThis.DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.match(describeM3uFetchError(timeout), /Zeitüberschreitung/);
  assert.match(describeM3uFetchError(new globalThis.DOMException('aborted', 'AbortError')), /Zeitüberschreitung/);
  assert.match(describeM3uFetchError(fetchFailed(coded('ETIMEDOUT'))), /Zeitüberschreitung/);
  assert.match(describeM3uFetchError(fetchFailed(coded('UND_ERR_CONNECT_TIMEOUT'))), /Zeitüberschreitung/);
});

test('TLS/Zertifikat', () => {
  for (const code of [
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'ERR_SSL_WRONG_VERSION_NUMBER',
  ]) {
    assert.match(describeM3uFetchError(fetchFailed(coded(code))), /TLS-\/Zertifikatsfehler/, code);
  }
});

test('Weiterleitung (redirect: error) -> Weiterleitung nicht erlaubt', () => {
  assert.match(describeM3uFetchError(fetchFailed(new Error('unexpected redirect'))), /Weiterleitung nicht erlaubt/);
});

test('Verbindung unterbrochen / kein Netz', () => {
  assert.match(describeM3uFetchError(fetchFailed(coded('ECONNRESET'))), /unterbrochen/);
  assert.match(describeM3uFetchError(fetchFailed(coded('ENETUNREACH'))), /nicht erreichbar/);
});

test('Fallback: bisheriger Text (HTTP-Status, unbekannte Ursache, Nicht-Error)', () => {
  assert.equal(describeM3uFetchError(new Error('HTTP 404')), 'HTTP 404');
  assert.equal(describeM3uFetchError(fetchFailed(coded('EWEIRD'))), 'fetch failed');
  assert.equal(describeM3uFetchError(new Error('Datei ist zu groß')), 'Datei ist zu groß');
  assert.equal(describeM3uFetchError('Text'), 'Text');
  assert.equal(describeM3uFetchError(undefined), 'undefined');
});

test('Keine URL, Zugangsdaten oder Hostnamen in der Ausgabe (auch nicht aus Cause-Texten)', () => {
  const secretUrl = 'https://nutzer:geheim@host.example/liste.m3u?token=abc123';
  const causes = [
    coded('ENOTFOUND', `getaddrinfo ENOTFOUND host.example (${secretUrl})`),
    coded('ECONNREFUSED', `connect ECONNREFUSED 10.0.0.1:443 ${secretUrl}`),
    coded('CERT_HAS_EXPIRED', `certificate for ${secretUrl}`),
    new Error(`unexpected redirect ${secretUrl}`),
    coded('ETIMEDOUT', secretUrl),
  ];
  for (const cause of causes) {
    const out = describeM3uFetchError(fetchFailed(cause));
    for (const secret of ['geheim', 'nutzer', 'abc123', 'host.example', 'https://', '10.0.0.1']) {
      assert.ok(!out.includes(secret), `"${secret}" in "${out}"`);
    }
  }
});

test('Zyklische cause-Kette terminiert', () => {
  const a = new Error('a');
  const b = new Error('b');
  a.cause = b;
  b.cause = a;
  assert.equal(describeM3uFetchError(a), 'a');
});
