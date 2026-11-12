'use strict';
// Aufruf: node ard.js <item-API-URL|partner/itemId>   -> Streams/Untertitel/Metadaten-Uebersicht
const { getJson, getText, parseMaster } = require('./lib');
(async () => {
  let u = process.argv[2];
  if (!/^https?:/.test(u)) { const [p, id] = u.split('/'); u = `https://api.ardmediathek.de/page-gateway/pages/${p}/item/${id}?devicetype=pc&embedded=true`; }
  const r = await getJson(u);
  console.log('HTTP', r.status);
  const j = r.json;
  console.log('root:', { title: j.title, coreAssetType: j.coreAssetType, fskRating: j.fskRating, id: j.id });
  const w = j.widgets.find((x) => x.mediaCollection);
  console.log('widget:', { blockedByFsk: w.blockedByFsk, geoblocked: w.geoblocked, maturity: w.maturityContentRating, availableTo: w.availableTo, broadcastedOn: w.broadcastedOn, show: w.show && Object.keys(w.show), title: w.title });
  const e = w.mediaCollection.embedded;
  console.log('meta:', JSON.stringify({ ...e.meta, images: undefined, synopsis: undefined }));
  console.log('isGeoBlocked', e.isGeoBlocked, 'subtitles', JSON.stringify(e.subtitles));
  for (const s of e.streams) {
    console.log('STREAM kind=', s.kind);
    for (const m of s.media) {
      console.log('  ', m.mimeType, m.forcedLabel || '', m.maxHResolutionPx + 'x' + m.maxVResolutionPx, m.videoCodec, 'audios=', JSON.stringify(m.audios), 'emb.sub=', m.hasEmbeddedSubtitles, JSON.stringify(m.subtitles), '\n     ', m.url);
    }
  }
  if (process.argv[3] === 'hls') {
    for (const s of e.streams) for (const m of s.media) if (/mpegurl/.test(m.mimeType)) {
      const t = await getText(m.url); console.log('HLS', s.kind, t.status, t.url);
      const p = parseMaster(t.text, t.url);
      console.log(' media:', JSON.stringify(p.media, null, 0));
      console.log(' variants:', p.variants.map((v) => `${v.RESOLUTION} ${v.BANDWIDTH} ${v.CODECS} aud=${v.AUDIO} sub=${v.SUBTITLES}`).join('\n   '));
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
