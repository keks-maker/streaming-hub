'use strict';
// Aufruf: node ard-series.js <Suchbegriff>  -> Serien-Treffer, Grouping, Staffeln, Folgenfelder
const { getJson } = require('./lib');
(async () => {
  const q = process.argv[2] || 'Babylon Berlin';
  const s = await getJson('https://api.ardmediathek.de/page-gateway/pages/ard/search?searchString=' + encodeURIComponent(q) + '&pageSize=24');
  console.log('search', s.status, Object.keys(s.json));
  const shows = s.json.showResults || [];
  console.log('shows:', shows.slice(0, 5).map((t) => [t.longTitle, t.type, t.links?.target?.href]));
  const sh = shows.find((t) => /grouping/.test(t.links?.target?.href || ''));
  if (!sh) return;
  const href = sh.links.target.href + (sh.links.target.href.includes('embedded') ? '' : '&embedded=true');
  const g = await getJson(href);
  console.log('grouping', g.status, g.json.title, g.json.coreAssetType);
  for (const w of g.json.widgets) {
    console.log('widget', w.type, w.title, 'teasers=', (w.teasers || []).length, 'pagination=', JSON.stringify(w.pagination), 'compilationType=', w.compilationType, 'links=', JSON.stringify(w.links));
    if (w.teasers) console.log(' first teaser keys', Object.keys(w.teasers[0]).join(','));
    for (const t of (w.teasers || []).slice(0, 4)) console.log('   ', JSON.stringify({ id: t.id, long: t.longTitle, type: t.type, cat: t.coreAssetType, dur: t.duration, bc: t.broadcastedOn, to: t.availableTo, season: t.season, ep: t.episode, href: t.links?.target?.href }));
  }
  require('fs').writeFileSync(process.argv[3] || '/dev/null', JSON.stringify(g.json));
})().catch((e) => { console.error(e); process.exit(1); });
