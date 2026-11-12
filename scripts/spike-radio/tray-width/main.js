'use strict';
// Spike: Breite des Tray-Eintrags über Lauftext-Schritte messen (Aufruf: node scripts/spike-radio/tray-width/run.js)
const { app, Tray, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { marqueeWindow } = require('../../../lib/radio/tray-marquee.js');
const TEXTS = [
  'Radio Bob! Rock · Metallica – Enter Sandman (Remastered 2021)',
  'WWWWWWWW iiiiiiiiii lllllll mmmm 🇩🇪🇩🇪 Ärger Übel 1234567890 iiiii',
];
app.whenReady().then(async () => {
  const img = nativeImage.createFromPath(path.join(__dirname, '../../../assets/tray/tray-idle.png'));
  const out = {};
  for (const mono of [false, true]) {
    for (const text of TEXTS) {
      const tray = new Tray(img);
      const widths = [];
      for (let step = 0; step < 90; step += 3) {
        const win = marqueeWindow(text, step).text;
        if (mono) tray.setTitle(win, { fontType: 'monospaced' });
        else tray.setTitle(win);
        await new Promise(r => setTimeout(r, 80));
        widths.push(tray.getBounds().width);
      }
      out[`${mono ? 'monospaced' : 'proportional'} | ${text.slice(0, 10)}`] = { min: Math.min(...widths), max: Math.max(...widths), distinct: new Set(widths).size, first: widths.slice(0, 12) };
      tray.destroy();
    }
  }
  fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(out, null, 1));
  app.quit();
});
