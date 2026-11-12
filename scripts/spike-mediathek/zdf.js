'use strict';
// Aufruf: node zdf.js <Dokument-ID|URL> [hls] -> Formitaeten, Untertitel, Metadaten
const { getJson, getText, parseMaster } = require('./lib');
(async () => {
  let u = process.argv[2];
  if (!/^https?:/.test(u)) u = 'https://zdf-prod-futura.zdf.de/mediathekV2/document/' + encodeURIComponent(u);
  const r = await getJson(u);
  console.log('HTTP', r.status);
  const d = r.json.document;
  const keys = Object.keys(d);
  console.log('keys:', keys.join(','));
  const pick = ['id', 'contentType', 'titel', 'headline', 'brandTitle', 'seriesTitle', 'season', 'seasonNumber', 'episode', 'episodeNumber', 'staffel', 'folge', 'airtime', 'editorialDate', 'offlineAvailability', 'length', 'fsk', 'fskCheck', 'geoLocation', 'hasVideo', 'channel', 'language', 'currentVideoType'];
  const o = {}; for (const k of pick) if (k in d) o[k] = d[k];
  console.log('meta:', JSON.stringify(o));
  console.log('formitaeten:', (d.formitaeten || []).length);
  for (const f of d.formitaeten || []) console.log('  ', f.type, '|', f.quality, '|', f.mimeType, '|', f.class, '|', f.audio ? JSON.stringify(f.audio) : '', '|', f.language, '|', f.url);
  console.log('captions:', JSON.stringify(d.captions), 'subtitle:', JSON.stringify(d.subtitle));
  for (const k of keys) if (/caption|subtit|untertitel|vtt|ttml|audiodesc|signlang|sprache/i.test(k)) console.log('K', k, JSON.stringify(d[k]).slice(0, 600));
  if (process.argv[3] === 'hls') {
    const f = (d.formitaeten || []).find((x) => /m3u8/.test(x.type));
    if (f) { const t = await getText(f.url); console.log('HLS', t.status); const p = parseMaster(t.text, t.url); console.log('media', JSON.stringify(p.media)); console.log(p.variants.map((v) => `${v.RESOLUTION} ${v.BANDWIDTH} ${v.CODECS} aud=${v.AUDIO} sub=${v.SUBTITLES}`).join('\n')); }
  }
})().catch((e) => { console.error(e); process.exit(1); });
