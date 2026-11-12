'use strict';
// Staffel-Widget der ARD: widgets/<partner>/asset/<groupingId>?seasoned=true&seasonNumber=N
const { getJson } = require('./lib');
(async () => {
  const id = process.argv[2] || 'Y3JpZDovL2Rhc2Vyc3RlLmRlL2JhYnlsb24tYmVybGlu';
  const season = process.argv[3] || '5';
  const u = `https://api.ardmediathek.de/page-gateway/widgets/ard/asset/${id}?pageNumber=0&pageSize=48&embedded=true&seasoned=true&seasonNumber=${season}&withAudiodescription=false&withOriginalWithSubtitle=false&withOriginalversion=false&single=false`;
  const r = await getJson(u);
  console.log('HTTP', r.status, Object.keys(r.json || {}).join(','));
  console.log('pagination', JSON.stringify(r.json.pagination), 'titles:');
  for (const t of r.json.teasers || []) console.log('  ', t.coreAssetType, '|', t.longTitle, '|', t.duration, t.broadcastedOn, t.availableTo, 'sub=', t.subtitled, t.maturityContentRating);
})();
