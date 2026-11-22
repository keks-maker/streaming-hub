#!/usr/bin/env node
// Legt App-ID `tv.streaminghub.desktopsync` (iCloud-Capability) und das Developer-ID-Profil (macOS) per App Store
// Connect API an bzw. erneuert es und schreibt es nach native/StreamingHubSync/Resources/StreamingHubSync.provisionprofile.
// Zugang: ~/.appstoreconnect/asc.env (ASC_KEY_ID, ASC_ISSUER_ID) und private_keys/*.p8 (Inhalte werden nie ausgegeben).
// Die Zuordnung des iCloud-Containers zur App-ID ist per API nicht möglich (einmalig im Developer-Portal, siehe
// native/StreamingHubSync/README.md); das Skript prüft, ob das Profil den Container enthält, und meldet sonst Exit 2.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const BUNDLE = 'tv.streaminghub.desktopsync';
const CONTAINER = 'iCloud.tv.streaminghub';
const PROFILE_NAME = 'StreamingHubSync DeveloperID';
const OUT = path.join(__dirname, '..', 'native', 'StreamingHubSync', 'Resources', 'StreamingHubSync.provisionprofile');

function credentials() {
  const dir = path.join(os.homedir(), '.appstoreconnect');
  const env = {};
  for (const line of fs.readFileSync(path.join(dir, 'asc.env'), 'utf8').split('\n')) {
    const m = line.match(/^(?:export\s+)?(\w+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  const keyFile = fs.readdirSync(path.join(dir, 'private_keys')).find((f) => f.endsWith('.p8'));
  if (!env.ASC_KEY_ID || !env.ASC_ISSUER_ID || !keyFile) throw new Error('ASC-Zugang unvollständig (asc.env / private_keys)');
  return { keyId: env.ASC_KEY_ID, issuer: env.ASC_ISSUER_ID, key: fs.readFileSync(path.join(dir, 'private_keys', keyFile)) };
}

function token({ keyId, issuer, key }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  const body = b64({ iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' });
  const sig = crypto.sign('SHA256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function request(creds, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'api.appstoreconnect.apple.com', path: apiPath, method,
      headers: { Authorization: `Bearer ${token(creds)}`, 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json;
        try { json = data ? JSON.parse(data) : null; } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function profileContainers(file) {
  const xml = execFileSync('security', ['cms', '-D', '-i', file], { encoding: 'utf8' });
  const plist = execFileSync('plutil', ['-extract', 'Entitlements.com\\.apple\\.developer\\.icloud-container-identifiers', 'json', '-o', '-', '-'],
    { input: xml, encoding: 'utf8' });
  return JSON.parse(plist);
}

async function main() {
  const creds = credentials();
  let r = await request(creds, 'GET', `/v1/bundleIds?filter[identifier]=${BUNDLE}`);
  let id = r.json && r.json.data && r.json.data.find((b) => b.attributes.identifier === BUNDLE)?.id;
  if (!id) {
    r = await request(creds, 'POST', '/v1/bundleIds', { data: { type: 'bundleIds', attributes: { identifier: BUNDLE, name: 'Streaming Hub Sync', platform: 'MAC_OS' } } });
    if (r.status !== 201) throw new Error(`App-ID anlegen fehlgeschlagen (${r.status})`);
    id = r.json.data.id;
    console.log('App-ID angelegt');
  }
  r = await request(creds, 'GET', `/v1/bundleIds/${id}/bundleIdCapabilities`);
  if (!(r.json.data || []).some((c) => c.attributes.capabilityType === 'ICLOUD')) {
    r = await request(creds, 'POST', '/v1/bundleIdCapabilities', { data: { type: 'bundleIdCapabilities',
      attributes: { capabilityType: 'ICLOUD', settings: [{ key: 'ICLOUD_VERSION', options: [{ key: 'XCODE_6' }] }] },
      relationships: { bundleId: { data: { type: 'bundleIds', id } } } } });
    if (r.status !== 201) throw new Error(`iCloud-Capability fehlgeschlagen (${r.status})`);
    console.log('iCloud-Capability aktiviert');
  }
  r = await request(creds, 'GET', '/v1/certificates?filter[certificateType]=DEVELOPER_ID_APPLICATION');
  const certs = (r.json.data || []).map((c) => ({ type: 'certificates', id: c.id }));
  if (!certs.length) throw new Error('Kein Developer-ID-Application-Zertifikat im Konto');
  r = await request(creds, 'GET', `/v1/bundleIds/${id}/profiles?limit=50`);
  for (const p of (r.json.data || [])) {
    if (p.attributes.name === PROFILE_NAME) await request(creds, 'DELETE', `/v1/profiles/${p.id}`);
  }
  r = await request(creds, 'POST', '/v1/profiles', { data: { type: 'profiles',
    attributes: { name: PROFILE_NAME, profileType: 'MAC_APP_DIRECT' },
    relationships: { bundleId: { data: { type: 'bundleIds', id } }, certificates: { data: certs } } } });
  if (r.status !== 201) throw new Error(`Profil anlegen fehlgeschlagen (${r.status})`);
  fs.writeFileSync(OUT, Buffer.from(r.json.data.attributes.profileContent, 'base64'));
  const containers = profileContainers(OUT);
  if (!containers.includes(CONTAINER)) {
    console.error(`Profil gespeichert (${path.relative(process.cwd(), OUT)}), enthält aber den Container ${CONTAINER} noch nicht.`);
    console.error('Einmalig im Developer-Portal: Identifiers > tv.streaminghub.desktopsync > iCloud > Configure > Container wählen > Save; danach dieses Skript erneut ausführen.');
    process.exit(2);
  }
  console.log(`Profil ok (Container ${CONTAINER}), gespeichert unter ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
