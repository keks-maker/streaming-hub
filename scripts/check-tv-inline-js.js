// Syntax-Check der inline <script>-Blöcke in tv.html (Fix-Set 3 QA)
const fs = require('fs');
const html = fs.readFileSync('tv.html', 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
let failed = false;
blocks.forEach((m, i) => {
  try {
    new Function(m[1]);
    console.log('script', i, 'OK');
  } catch (e) {
    failed = true;
    console.log('script', i, 'SYNTAX-ERROR:', e.message);
  }
});
const count = (html.match(/tvRecEntries/g) || []).length;
console.log('tvRecEntries occurrences:', count);
if (count < 2) { console.log('EXPECTED >= 2 (container + JS ref)'); failed = true; }
process.exit(failed ? 1 : 0);
