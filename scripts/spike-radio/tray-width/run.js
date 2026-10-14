'use strict';
const { _electron } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const result = path.join(__dirname, 'result.json');
  fs.rmSync(result, { force: true });
  const app = await _electron.launch({ args: [__dirname] });
  for (let i = 0; i < 90 && !fs.existsSync(result); i++) await new Promise(r => setTimeout(r, 1000));
  await app.close().catch(() => {});
  console.log(fs.existsSync(result) ? fs.readFileSync(result, 'utf8') : 'kein Ergebnis');
})();
