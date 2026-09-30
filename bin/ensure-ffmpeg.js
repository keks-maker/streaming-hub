#!/usr/bin/env node
// v0.5.7 – ffmpeg/ffprobe-Selbstheilung ohne App-Start (Konzept §2.2)
//
// Dünner CLI-Wrapper um lib/ffmpeg.js für install.sh und updater.js:
//   node bin/ensure-ffmpeg.js [appRoot]
// appRoot defaultet auf das Repo-Verzeichnis (eine Ebene über bin/).
// Exit 0 = Binaries bereit (ok oder frisch geladen), 1 = Fehlschlag
// (Netzwerk, Prüfsumme, nicht unterstützte Plattform).

'use strict';

const path = require('path');
const { ensureBinaries } = require('../lib/ffmpeg.js');

const appRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');

ensureBinaries(appRoot).then(result => {
  if (!result.ok) {
    console.error(`ffmpeg/ffprobe konnten nicht bereitgestellt werden: ${result.error}`);
    process.exit(1);
  }
  console.log(
    `ffmpeg/ffprobe bereit: ${result.ffmpeg.path} (${result.ffmpeg.action}), ${result.ffprobe.path} (${result.ffprobe.action})`,
  );
  process.exit(0);
});
