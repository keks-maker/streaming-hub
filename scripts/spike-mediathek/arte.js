'use strict';
// Aufruf: node arte.js <programId> [hls]  -> player/v2/config: Streams, Versionen, Untertitel, Metadaten
const { getJson, getText, parseMaster } = require('./lib');
(async () => {
  const id = process.argv[2];
  const r = await getJson('https://api.arte.tv/api/player/v2/config/de/' + encodeURIComponent(id));
  console.log('HTTP', r.status);
  if (!r.json) { console.log(r.text.slice(0, 400)); return; }
  const a = r.json.data?.attributes;
  if (!a) { console.log(JSON.stringify(r.json).slice(0, 600)); return; }
  console.log('attr keys:', Object.keys(a).join(','));
  console.log('meta:', JSON.stringify({ ...a.metadata, description: undefined, images: undefined }).slice(0, 900));
  console.log('rights:', JSON.stringify(a.rights), 'restriction:', JSON.stringify(a.restriction), 'geoblocking:', JSON.stringify(a.geoblocking));
  console.log('streams:', a.streams?.length);
  for (const s of a.streams || []) console.log('  ', s.protocol, s.mediaType || '', 'versions=', JSON.stringify(s.versions), 'slot=', s.slot, '\n     ', s.url);
  for (const k of Object.keys(a)) if (/subtit|caption/i.test(k)) console.log('K', k, JSON.stringify(a[k]).slice(0, 500));
  if (process.argv[3] === 'hls') {
    for (const s of a.streams.filter((x) => /HLS/.test(x.protocol))) {
      const t = await getText(s.url); console.log('HLS', JSON.stringify(s.versions?.map((v) => v.shortLabel)), t.status);
      const p = parseMaster(t.text, t.url);
      console.log(' media:', p.media.map((m) => `${m.TYPE} ${m['GROUP-ID']} ${m.LANGUAGE} "${m.NAME}" ${m.CHARACTERISTICS || ''} def=${m.DEFAULT} forced=${m.FORCED || ''} ${(m.URI || '').slice(-50)}`).join('\n         '));
      console.log(' variants:', p.variants.map((v) => `${v.RESOLUTION} ${v.BANDWIDTH} aud=${v.AUDIO} sub=${v.SUBTITLES}`).join(' | '));
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
