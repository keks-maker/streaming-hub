'use strict';
// Aufruf: node arte-series.js <RC-Code>  -> Sammlungsseite: Zonen, Unterreihen (Staffeln), Folgenfelder
const { getJson } = require('./lib');
(async () => {
  const code = process.argv[2] || 'RC-022041';
  const r = await getJson(`https://api.arte.tv/api/emac/v3/de/web/pages/${code}/`);
  console.log('HTTP', r.status, 'title', r.json.title);
  for (const z of r.json.zones) {
    console.log('ZONE', z.code?.name, '|', z.title, '| n=', (z.data || []).length, '| next=', z.nextPage);
    for (const t of (z.data || []).slice(0, 4)) console.log('   ', JSON.stringify({ kind: t.kind?.code, pid: t.programId, title: t.title, sub: t.subtitle, dur: t.duration, av: t.availability, ep: t.episode, season: t.season, keys: Object.keys(t).join(',') }).slice(0, 700));
  }
})();
