'use strict';

// Tests: Härtung von lib/radio/radio-http.js (Deadline beim Body-Lesen, Redirect-Ziele mit Zugangsdaten).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { nodeFetch, withDeadline, fetchFollow, readLimited, parseHttpUrl } = require('../lib/radio/radio-http.js');

let server;
let base;
test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/endless') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      const timer = setInterval(() => res.write(Buffer.alloc(512, 1)), 2);
      req.on('close', () => clearInterval(timer));
    } else if (req.url === '/to-creds') {
      res.writeHead(302, { Location: `http://user:pw@127.0.0.1:${server.address().port}/x` });
      res.end();
    } else {
      res.writeHead(200);
      res.end('ok');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
});

test('Deadline während des Body-Lesens wirft Zeitüberschreitung statt still abzuschneiden', async () => {
  await assert.rejects(
    withDeadline(400, async signal => {
      const response = await nodeFetch(`${base}/endless`, { signal });
      return readLimited(response, 1024 * 1024 * 1024);
    }),
    /Zeitüberschreitung/
  );
});

test('Größenlimit schneidet weiterhin ohne Fehler ab (truncated)', async () => {
  const result = await withDeadline(5000, async signal => {
    const response = await nodeFetch(`${base}/endless`, { signal });
    return readLimited(response, 4096);
  });
  assert.equal(result.truncated, true);
  assert.ok(result.buffer.length <= 4096);
});

test('Redirect-Ziel mit Zugangsdaten wird abgelehnt', async () => {
  await assert.rejects(fetchFollow(`${base}/to-creds`), /Zugangsdaten/);
});

test('parseHttpUrl lehnt Adressen mit Zugangsdaten ab', () => {
  assert.throws(() => parseHttpUrl('http://user:pw@host.test/'), /Zugangsdaten/);
  assert.throws(() => parseHttpUrl('https://user@host.test/'), /Zugangsdaten/);
  assert.equal(parseHttpUrl('https://host.test/a').hostname, 'host.test');
});
