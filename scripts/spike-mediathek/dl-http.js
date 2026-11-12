'use strict';
// MP4-Direktdownload mit Range-Resume. Aufruf: node dl-http.js <url> <zieldatei> [maxBytes]
// Laedt in zwei Etappen (Abbruch bei halber Menge, Resume per Range) und prueft die Gesamtgroesse.
const fs = require('fs');
const { UA } = require('./lib');
async function pull(url, file, start, limit) {
  const headers = { 'User-Agent': UA };
  if (start > 0) headers.Range = `bytes=${start}-`;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
  console.log('  GET', start > 0 ? `Range ${start}-` : '(voll)', '->', r.status, 'len', r.headers.get('content-length'), 'accept-ranges', r.headers.get('accept-ranges'), 'content-range', r.headers.get('content-range'));
  if (start > 0 && r.status !== 206) throw new Error('Server ignoriert Range: ' + r.status);
  const ws = fs.createWriteStream(file, { flags: start > 0 ? 'a' : 'w' });
  let got = 0;
  const total = Number(r.headers.get('content-length')) + start;
  for await (const chunk of r.body) {
    ws.write(chunk); got += chunk.length;
    if (limit && got >= limit) { break; }
  }
  await new Promise((res) => ws.end(res));
  return total;
}
(async () => {
  const [url, file, maxStr] = process.argv.slice(2);
  const max = Number(maxStr) || 4 * 1024 * 1024;
  const head = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } });
  console.log('HEAD', head.status, 'len', head.headers.get('content-length'), 'accept-ranges', head.headers.get('accept-ranges'), 'type', head.headers.get('content-type'));
  const total = await pull(url, file, 0, max / 2);
  const part = fs.statSync(file).size;
  console.log('  Teil 1:', part, 'von', total);
  // Resume bis max Bytes
  const r = await fetch(url, { headers: { 'User-Agent': UA, Range: `bytes=${part}-${max - 1}` } });
  console.log('  Resume', r.status, r.headers.get('content-range'));
  const buf = Buffer.from(await r.arrayBuffer());
  fs.appendFileSync(file, buf);
  console.log('  Datei jetzt', fs.statSync(file).size, 'Bytes (Soll', max + ')');
})().catch((e) => { console.error(e); process.exit(1); });
