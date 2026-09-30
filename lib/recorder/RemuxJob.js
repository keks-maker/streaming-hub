// v0.5.8 – Remux HLS-Zwischenform → MP4 (Aufnahme Phase 1b, Karte t_17ee2ca5)
//
// Nach dem Stopp (Konzept §2.3): `ffmpeg -i index.m3u8 -c copy
// -movflags +faststart <Name>.mp4` — stream-copy, keine Neukodierung.
// Fortschritt via `-progress` (Prozent + Restdauer aus out_time vs.
// erwarteter Gesamtdauer der Zwischenplaylist).
//
// Probe-Erkenntnis (Karte t_17ee2ca5, 2026-09-30): Eine HLS-Playlist ohne
// #EXT-X-ENDLIST wird vom ffmpeg-HLS-Demuxer als live behandelt — der Remux
// hängt endlos. Dieser Job sichert ENDLIST deshalb defensiv selbst an die
// Playlist an (idempotent), bevor ffmpeg gestartet wird.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Hängt #EXT-X-ENDLIST an, wenn die Playlist sie nicht enthält (idempotent).
 * Ohne diesen Schritt wartet der HLS-Demuxer ewig auf neue Segmente.
 */
function ensureEndlist(playlistPath) {
  const raw = fs.readFileSync(playlistPath, 'utf-8');
  if (/^\s*#EXT-X-ENDLIST\s*$/m.test(raw)) return false;
  fs.appendFileSync(playlistPath, raw.endsWith('\n') ? '#EXT-X-ENDLIST\n' : '\n#EXT-X-ENDLIST\n', 'utf-8');
  return true;
}

/**
 * Parst ffmpeg-`-progress`-Zeilen (out_time=HH:MM:SS.micro; out_time_ms ist
 * trotz des Namens in Mikrosekunden) in Sekunden.
 */
function parseOutTimeSeconds(fields) {
  if (typeof fields.out_time === 'string') {
    const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(fields.out_time.trim());
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  if (fields.out_time_ms !== undefined) {
    const micro = Number(fields.out_time_ms);
    if (Number.isFinite(micro) && micro > 0) return micro / 1e6;
  }
  if (fields.out_time_us !== undefined) {
    const micro = Number(fields.out_time_us);
    if (Number.isFinite(micro) && micro > 0) return micro / 1e6;
  }
  return null;
}

function computeRemuxProgress({ outTimeSec, expectedDurationSec }) {
  if (outTimeSec === null) return { percent: null, remainingSec: null };
  if (!Number.isFinite(expectedDurationSec) || expectedDurationSec <= 0) {
    return { percent: null, remainingSec: null };
  }
  const percent = Math.max(0, Math.min(100, (outTimeSec / expectedDurationSec) * 100));
  const remainingSec = Math.max(0, expectedDurationSec - outTimeSec);
  return { percent, remainingSec };
}

/**
 * Liest Dauer + Streams der fertigen MP4 mit ffprobe (Verifikation, Konzept §2.3).
 * Wirft bei nicht lesbarer/leerer Datei.
 */
function probeMp4(ffprobePath, mp4Path, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration,size',
      '-show_entries', 'stream=codec_type,codec_name',
      '-of', 'json',
      mp4Path,
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL' });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => (out += chunk));
    child.stderr.on('data', chunk => (err += chunk));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffprobe fehlgeschlagen (code ${code}): ${err.trim().slice(0, 400)}`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch (e) {
        reject(new Error(`ffprobe-Ausgabe nicht parsebar: ${e.message}`));
        return;
      }
      const durationSec = parsed?.format?.duration !== undefined ? Number(parsed.format.duration) : null;
      const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
      resolve({
        durationSec: Number.isFinite(durationSec) ? durationSec : null,
        fileSizeBytes: fs.statSync(mp4Path).size,
        streamTypes: streams.map(s => s.codec_type).filter(Boolean),
        codecs: streams.map(s => s.codec_name).filter(Boolean),
      });
    });
  });
}

/**
 * Führt den Remux aus.
 *
 * options:
 * - ffmpegPath, ffprobePath: Binary-Pfade (lib/ffmpeg.js)
 * - dir: Job-Verzeichnis (enthält index.m3u8 + *.ts)
 * - playlistPath: HLS-Zwischenplaylist (Default dir/index.m3u8)
 * - outputPath: Zieldatei .mp4
 * - expectedDurationSec: erwartete Gesamtdauer (aus der Zwischenplaylist)
 * - onProgress({ percent, remainingSec, timeSec }): Fortschritts-Callback
 *
 * Rückgabe (Promise): { durationSec, fileSizeBytes, streamTypes, codecs }
 * Verhalten bei Fehlschlag: halbfertige MP4 wird gelöscht, Zwischenstände
 * bleiben für Retry erhalten (Statusverwaltung im RecorderService).
 */
function runRemux({
  ffmpegPath,
  ffprobePath,
  dir,
  playlistPath,
  outputPath,
  expectedDurationSec = null,
  onProgress = null,
} = {}) {
  if (!ffmpegPath) return Promise.reject(new Error('Remux benötigt ffmpegPath'));
  if (!outputPath || !/\.mp4$/i.test(outputPath)) {
    return Promise.reject(new Error('Remux benötigt outputPath mit .mp4-Endung'));
  }
  const playlist = playlistPath || path.join(dir, 'index.m3u8');

  return new Promise((resolve, reject) => {
    try {
      // Ohne ENDLIST hängt der HLS-Demuxer (Probe-Befund) — sicherstellen.
      ensureEndlist(playlist);
    } catch (e) {
      reject(new Error(`Zwischenplaylist nicht lesbar: ${e.message}`));
      return;
    }

    let settled = false;
    let child;
    let stderrTail = '';
    let lastProgress = null;

    const emitProgress = fields => {
      const timeSec = parseOutTimeSeconds(fields);
      if (timeSec === null || typeof onProgress !== 'function') return;
      const { percent, remainingSec } = computeRemuxProgress({ outTimeSec: timeSec, expectedDurationSec });
      lastProgress = { timeSec, percent, remainingSec };
      try {
        onProgress(lastProgress);
      } catch (_) {
        // Progress-Consumer-Fehler darf den Remux nicht abbrechen
      }
    };

    const fail = err => {
      if (settled) return;
      settled = true;
      // Halbfertige MP4 entfernen — Zwischenstände bleiben für Retry.
      try {
        fs.rmSync(outputPath, { force: true });
      } catch (_) {}
      reject(err);
    };

    const succeed = async () => {
      if (settled) return;
      try {
        const probe = await probeMp4(ffprobePath, outputPath);
        if (!probe.durationSec || probe.durationSec <= 0) {
          fail(new Error('Remux-Ergebnis hat keine gültige Dauer — MP4 verworfen'));
          return;
        }
        settled = true;
        resolve(probe);
      } catch (e) {
        fail(e);
      }
    };

    try {
      child = spawn(ffmpegPath, [
        '-nostdin',
        '-hide_banner',
        '-v', 'error',
        '-i', playlist,
        '-c', 'copy',
        '-movflags', '+faststart',
        '-progress', 'pipe:1',
        '-nostats',
        '-y',
        outputPath,
      ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      fail(new Error(`ffmpeg konnte nicht gestartet werden: ${e.message}`));
      return;
    }

    child.on('error', e => fail(new Error(`ffmpeg-Fehler: ${e.message}`)));

    // -progress schreibt key=value-Zeilen auf stdout
    let progressBuf = '';
    child.stdout.on('data', chunk => {
      progressBuf += chunk;
      let nl;
      while ((nl = progressBuf.indexOf('\n')) !== -1) {
        const line = progressBuf.slice(0, nl).trim();
        progressBuf = progressBuf.slice(nl + 1);
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        emitProgress({ [line.slice(0, eq)]: line.slice(eq + 1) });
      }
    });

    child.stderr.on('data', chunk => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    child.on('close', code => {
      if (code === 0) {
        succeed();
      } else {
        fail(new Error(`ffmpeg Remux fehlgeschlagen (code ${code}): ${stderrTail.trim().slice(-400) || 'kein stderr'}`));
      }
    });
  });
}

module.exports = {
  runRemux,
  ensureEndlist,
  parseOutTimeSeconds,
  computeRemuxProgress,
  probeMp4,
};
