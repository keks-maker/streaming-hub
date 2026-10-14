'use strict';

// Test-Helfer (Radio): lokaler HTTP-Server mit Playlists, Redirects, ICY-Stream und hängenden Antworten.
// Dateien in tests/helpers sind KEINE Tests.

const http = require('node:http');
const net = require('node:net');

const AUDIO = Buffer.alloc(2048, 0x55);

/** ICY-Stream: Audioblöcke der Größe metaint, dazwischen Metadatenblöcke (Titel je Index in titles). */
function icyBody(metaint, titles, { encoding = 'utf8' } = {}) {
  const parts = [];
  for (const title of titles) {
    parts.push(Buffer.alloc(metaint, 0x11));
    if (title === null) {
      parts.push(Buffer.from([0]));
      continue;
    }
    const meta = Buffer.from(`StreamTitle='${title}';StreamUrl='';`, encoding);
    const blocks = Math.ceil(meta.length / 16);
    const padded = Buffer.alloc(blocks * 16);
    meta.copy(padded);
    parts.push(Buffer.from([blocks]), padded);
  }
  return Buffer.concat(parts);
}

/**
 * Rohes TCP wie streamabc.net: Statuszeile endet nur mit LF ("HTTP/1.0 200 OK\n", danach CRLF-Header). Electrons
 * eingebauter fetch (undici) lehnt das ab ("Missing expected CR after response line"), node:http mit
 * insecureHTTPParser nimmt es an. (Echtes "ICY 200 OK" lehnt auch node:http ab.) /redirect leitet per 302 auf /icy.mp3 um (wie streams.detektor.fm -> streamabc.net).
 */
function startRawIcyServer() {
  const server = net.createServer(socket => {
    let head = '';
    socket.on('error', () => {});
    socket.on('data', chunk => {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      const line = head.split('\r\n')[0];
      const path = (line.split(' ')[1] || '/').split('?')[0];
      const wantsMeta = /icy-metadata:\s*1/i.test(head);
      const base = `http://127.0.0.1:${server.address().port}`;
      if (path === '/redirect') {
        socket.end(`HTTP/1.1 302 Found\r\nLocation: ${base}/icy.mp3?sABC=token\r\nContent-Length: 0\r\n\r\n`);
      } else if (path === '/icy.mp3') {
        const body = wantsMeta ? icyBody(2048, [null, 'Roh - Titel']) : Buffer.alloc(8192, 0x33);
        const metaint = wantsMeta ? 'icy-metaint:2048\r\n' : '';
        socket.end(Buffer.concat([Buffer.from(`HTTP/1.0 200 OK\nicy-name:Roher ICY\r\ncontent-type:audio/mpeg\r\n${metaint}\r\n`, 'latin1'), body]));
      } else if (path === '/garbage') {
        socket.end('das ist kein HTTP\r\n\r\n');
      } else {
        socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      }
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise(done => {
            server.close(done);
            server.closeAllConnections?.();
          }),
      })
    );
  });
}

async function startRadioServer() {
  const log = { icyRequests: [], bytesSent: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (type, body, status = 200, headers = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...headers });
      res.end(body);
    };
    switch (url.pathname) {
      case '/direct.mp3':
        return send('audio/mpeg', AUDIO, 200, { 'icy-name': 'Testradio' });
      case '/live.mp3': {
        // Endlos-Stream: zeigt, dass der Leser nach dem Limit abbricht
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        const timer = setInterval(() => {
          log.bytesSent += AUDIO.length;
          res.write(AUDIO);
        }, 1);
        req.on('close', () => clearInterval(timer));
        return undefined;
      }
      case '/list.pls':
        return send('audio/x-scpls', `[playlist]\nNumberOfEntries=1\nFile1=${base}/direct.mp3\nTitle1=Test\nLength1=-1\nVersion=2\n`);
      case '/list.m3u':
        return send('audio/x-mpegurl', `#EXTM3U\n#EXTINF:-1,Test\n/direct.mp3\n`);
      case '/list.asx':
        return send('video/x-ms-asf', `<asx version="3.0"><entry><ref href="${base}/direct.mp3"/></entry></asx>`);
      case '/hls.m3u8':
        return send('application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6,\nseg0.aac\n');
      case '/hls-master.m3u8':
        return send('application/x-mpegURL', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000\nlow.m3u8\n');
      case '/redirect1':
        return send('text/plain', '', 302, { Location: '/redirect2' });
      case '/redirect2':
        return send('text/plain', '', 301, { Location: '/direct.mp3' });
      case '/loop':
        return send('text/plain', '', 302, { Location: '/loop' });
      case '/to-file':
        return send('text/plain', '', 302, { Location: 'file:///etc/passwd' });
      case '/nested.pls':
        return send('audio/x-scpls', `[playlist]\nFile1=${base}/nested.pls\n`);
      case '/pls-but-audio':
        // "-pls"-URL, die direkt Audio liefert (R0-Messung TranceBase)
        return send('audio/aacp', AUDIO, 200, { 'icy-name': 'Trance' });
      case '/octet':
        return send('application/octet-stream', Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 9, 8, 7, 0]));
      case '/html':
        return send('text/html', '<html><body>Nichts zu hören</body></html>');
      case '/big.m3u':
        return send('audio/x-mpegurl', `#EXTM3U\n${'#'.repeat(200 * 1024)}\n/direct.mp3\n`);
      case '/missing':
        return send('text/plain', 'weg', 404);
      case '/hang':
        return undefined; // antwortet nie
      case '/icy.mp3': {
        log.icyRequests.push(req.headers['icy-metadata']);
        const wants = req.headers['icy-metadata'] === '1';
        if (!wants) return send('audio/mpeg', AUDIO);
        const body = icyBody(4096, [null, 'Interpret - Lied']);
        return send('audio/mpeg', body, 200, { 'icy-metaint': '4096', 'icy-name': 'ICY Test' });
      }
      case '/icy-latin1.mp3':
        return send('audio/mpeg', icyBody(1024, ['Björk - Jóga'], { encoding: 'latin1' }), 200, { 'icy-metaint': '1024' });
      case '/icy-none.mp3':
        return send('audio/mpeg', AUDIO, 200);
      case '/icy-endless.mp3': {
        // metaint, aber nie ein Titel: der Leser muss am Limit abbrechen
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'icy-metaint': '1024' });
        const block = Buffer.concat([Buffer.alloc(1024, 0x22), Buffer.from([0])]);
        const timer = setInterval(() => {
          log.bytesSent += block.length;
          res.write(block);
        }, 1);
        req.on('close', () => clearInterval(timer));
        return undefined;
      }
      default:
        return send('text/plain', 'unbekannt', 404);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  server.closeAllConnections?.();
  const raw = await startRawIcyServer();
  return {
    base,
    rawBase: raw.base,
    log,
    close: () =>
      Promise.all([
        raw.close(),
        new Promise(resolve => {
          server.closeAllConnections();
          server.close(resolve);
        }),
      ]),
  };
}

module.exports = { startRadioServer, startRawIcyServer, icyBody, AUDIO };
