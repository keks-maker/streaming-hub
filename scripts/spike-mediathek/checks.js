'use strict';
// Besonderheiten: Sperren (FSK/Zeitfenster), DRM-Marker, Token in URLs, Rate-Limit-Probe.
const { getJson, getText, parseMaster } = require('./lib');
(async () => {
  // 1) ARTE mit Zeitfenster (FSK16, Sendezeit ab 22 Uhr)
  const a = (await getJson('https://api.arte.tv/api/player/v2/config/de/067769-001-A')).json;
  console.log('ARTE gesperrt:', JSON.stringify({ streams: a.data.attributes.streams, warnings: a.data.attributes.warnings, error: a.data.attributes.error, restriction: a.data.attributes.restriction.timeSlot, age: a.data.attributes.restriction.ageRestriction }));
  // 2) ARD FSK16 (Zeitfenster): blockedByFsk, kein mediaCollection
  const ard = (await getJson('https://api.ardmediathek.de/page-gateway/pages/one/item/Y3JpZDovL3dkci5kZS9CZWl0cmFnLXNvcGhvcmEtOWMyYTVlZjgtOWFiNy00ZGJhLTlkZmQtZWU1Mzg5ODY2NGM1?devicetype=pc&embedded=true')).json;
  const w = ard.widgets.find((x) => x.type === 'player_ondemand');
  console.log('ARD FSK16:', JSON.stringify({ blockedByFsk: w.blockedByFsk, maturity: w.maturityContentRating, mc: !!w.mediaCollection, fskRating: ard.fskRating, playerConfig: w.playerConfig }));
  // 3) DRM-/Token-Marker in HLS-Playlists
  const targets = {
    ZDF: 'https://zdfvod.akamaized.net/i/mp4/none/zdf/26/01/260108_2015_sendung_dbd/1/260108_2015_sendung_dbd,_a1a2_508k_p9,_a3a4_508k_p9,_a1a2_808k_p11,_a1a2_1628k_p13,_a1a2_3328k_p15,_a1a2_6628k_p61,v17.mp4.csmil/master.m3u8?audiotrack=0:deu:TV%20Ton,1:deu:Audiodeskription',
    ARTE: 'https://manifest-arte.akamaized.net/api/manifest/v1/Generate/bae5e6bb-9b12-4827-9056-e5ee31550e21/de/XQ+KS+CHEV1/101849-001-A.m3u8',
    ARD: 'https://wdradaptiv-vh.akamaihd.net/i/media/p/public/deChAt/2026/10/08/2d957929-f624-49a6-8bbf-02198c427f8b/2d957929-f624-49a6-8bbf-02198c427f8b_AVC-,270,360,540,720,1080,.mp4.csmil/master.m3u8',
  };
  for (const [k, u] of Object.entries(targets)) {
    const m = await getText(u); const p = parseMaster(m.text, m.url);
    const v = p.variants.sort((x, y) => y.BANDWIDTH - x.BANDWIDTH)[0];
    const vp = await getText(v.URI);
    console.log(k, 'master-hdr:', JSON.stringify({ cc: m.headers['cache-control'], exp: m.headers.expires }), '| EXT-X-KEY im Master:', /EXT-X-(SESSION-)?KEY/.test(m.text), '| in Variante:', (vp.text.match(/#EXT-X-KEY.*/) || ['-'])[0].slice(0, 80), '| Query-Token:', /[?&](hdnea|token|exp|sig|hdcore)=/i.test(u + v.URI), '| Segmentanzahl:', (vp.text.match(/#EXTINF/g) || []).length, '| fMP4-Map:', (vp.text.match(/#EXT-X-MAP.*/) || ['-'])[0].slice(0, 60));
  }
  // 4) Rate-Limit-Probe: 40 Abrufe, 8 parallel
  for (const [k, u] of Object.entries({ ARD: 'https://api.ardmediathek.de/page-gateway/pages/ard/search?searchString=tatort&pageSize=24', ZDF: 'https://zdf-prod-futura.zdf.de/mediathekV2/document/neuanfaenge-110', ARTE: 'https://api.arte.tv/api/player/v2/config/de/101849-001-A' })) {
    const codes = {}; const t0 = Date.now();
    for (let i = 0; i < 5; i++) await Promise.all(Array.from({ length: 8 }, () => getText(u).then((r) => { codes[r.status] = (codes[r.status] || 0) + 1; if (r.headers['retry-after'] || r.headers['x-ratelimit-remaining']) codes.rl = r.headers['x-ratelimit-remaining'] || r.headers['retry-after']; })));
    console.log('Rate', k, JSON.stringify(codes), ((Date.now() - t0) / 1000).toFixed(1) + 's');
  }
})().catch((e) => { console.error(e); process.exit(1); });
