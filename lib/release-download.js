'use strict';

// Download eines Release-Assets (Updater und Sync-Helfer-Bezug): Größenlimit, Vollständigkeitsprüfung, Datei nur neu anlegen.
const fs = require('fs');

const MAX_UPDATE_BYTES = 512 * 1024 * 1024;

async function downloadAsset(url, destination) {
  const response = await fetch(url, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'Streaming-Hub' },
    redirect: 'follow',
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok || !response.body) throw new Error(`Release-Asset Download ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_UPDATE_BYTES) throw new Error('Release-Asset ist zu groß');
  const file = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_UPDATE_BYTES) throw new Error('Release-Asset ist zu groß');
      if (!file.write(value)) await new Promise((resolve, reject) => { file.once('drain', resolve); file.once('error', reject); });
    }
    await new Promise((resolve, reject) => { file.once('finish', resolve); file.once('error', reject); file.end(); });
    if (declared && received !== declared) throw new Error('Unvollständiger Release-Asset-Download');
  } catch (error) {
    file.destroy();
    throw error;
  }
}

module.exports = { downloadAsset, MAX_UPDATE_BYTES };
