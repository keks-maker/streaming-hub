#!/usr/bin/env node
// Fake-StreamingHubSync für Tests: spricht das JSON-Zeilen-Protokoll (native/StreamingHubSync/PROTOCOL.md), gesteuert per Env.
//   FAKE_LOG        Datei, in die jede empfangene Zeile (JSON) angehängt wird
//   FAKE_ACCOUNT    available (Standard) | no_account | unavailable
//   FAKE_PROTOCOL   Antwort-Protokollversion (Standard 1) – bei Abweichung ok:false unsupported_protocol
//   FAKE_RESULT     JSON-Objekt als sync-result (Standard: nur lastSync)
//   FAKE_SYNC_ERROR Fehlercode für sync (z. B. no_account)
//   FAKE_MODE       crash-once (stirbt beim ersten sync, Zähler FAKE_COUNTER) | crash-always | eof-once | hang | garbage
//   FAKE_EVENTS     JSON-Array roher Zeilen nach hello (z. B. [{"event":"remoteChange"}])
const fs = require('fs');
const log = line => { if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, line + '\n'); };
const send = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const mode = process.env.FAKE_MODE || '';
function firstTime() {
  const file = process.env.FAKE_COUNTER;
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, '1');
  return true;
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));
function handle(line) {
  log(line);
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  if (mode === 'garbage') { process.stdout.write('das ist kein json\n[1,2]\n"x"\n'); }
  if (msg.cmd === 'hello') {
    if (msg.protocol !== Number(process.env.FAKE_PROTOCOL || 1)) { send({ id: msg.id, ok: false, error: { code: 'unsupported_protocol', message: 'nein' } }); return; }
    send({ id: msg.id, ok: true, result: { protocol: 1, helperVersion: '1.0.0', account: process.env.FAKE_ACCOUNT || 'available', kinds: ['Progress', 'Recent', 'Queue'], lastSync: null } });
    for (const event of JSON.parse(process.env.FAKE_EVENTS || '[]')) send(event);
  } else if (msg.cmd === 'sync') {
    if (mode === 'crash-always' || (mode === 'crash-once' && firstTime())) process.exit(3);
    if (mode === 'eof-once' && firstTime()) { process.stdout.end(); setInterval(() => {}, 1000); return; }
    if (mode === 'hang') return;
    if (process.env.FAKE_SYNC_ERROR) { send({ id: msg.id, ok: false, error: { code: process.env.FAKE_SYNC_ERROR, message: 'Fehler' } }); return; }
    send({ id: msg.id, ok: true, result: { apply: [], remove: [], uploaded: [], settled: msg.pending || [], failed: [], zoneReset: false, lastSync: 1763800000, ...JSON.parse(process.env.FAKE_RESULT || '{}') } });
  } else if (msg.cmd === 'shutdown') {
    send({ id: msg.id, ok: true, result: {} });
    process.exit(0);
  } else {
    send({ id: msg.id ?? null, ok: false, error: { code: 'unknown_command', message: 'x' } });
  }
}
