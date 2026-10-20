'use strict';

// ffmpeg-Aufrufe der Downloads (rein): Muxen mehrerer Eingänge (Video, Tonspuren, WebVTT) ohne Transcoding und Konvertierung einer
// WebVTT-Datei in .srt. Die Ausgabe geht in eine .part-Datei (Container deshalb explizit per -f). Spike-Bericht §4: mov_text im MP4,
// srt im MKV, HEVC mit -tag:v hvc1, MP4 mit +faststart; Eingänge einzeln statt Master (-map 0 würde alle Varianten liefern).

const { parseOutTimeSeconds } = require('../recorder/RemuxJob.js');

const DEFAULT_PROTOCOLS = 'http,https,tcp,tls,crypto';
const FORMAT_OF = { mp4: 'mp4', mkv: 'matroska' };

const isHttp = url => /^https?:\/\//i.test(String(url));

/** Optionen vor jedem -i: nur http(s)-Eingänge erhalten die Netzoptionen (für Dateien wären sie unbekannt = Fehler). */
function inputOptions(url, { userAgent, protocolWhitelist, readRate }) {
  const args = ['-protocol_whitelist', protocolWhitelist];
  if (isHttp(url)) {
    if (userAgent) args.push('-user_agent', userAgent);
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  if (readRate) args.push('-readrate', String(readRate));
  return args;
}

/**
 * Argumente für den Mux-Lauf. plan: Plan aus track-selection.js, inputUrls: aufgelöste Eingänge (gleiche Reihenfolge wie
 * plan.inputs), outFile: Zieldatei (.part), meta: { title, show, season, episode, date }, readRate: optional (Bandbreitenlimit,
 * Faktor der Echtzeit für den Videoeingang).
 */
function buildMuxArgs({ plan, inputUrls, outFile, meta = {}, userAgent = null, protocolWhitelist = DEFAULT_PROTOCOLS, readRate = null }) {
  if (!Array.isArray(inputUrls) || inputUrls.length !== plan.inputs.length || !inputUrls.length) throw new Error('Eingänge passen nicht zum Plan');
  const mp4 = plan.container === 'mp4';
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  inputUrls.forEach((url, index) => args.push(...inputOptions(url, { userAgent, protocolWhitelist, readRate: index === 0 ? readRate : null }), '-i', url));
  args.push('-map', '0:v:0');
  for (const audio of plan.audio) args.push('-map', `${audio.input}:${audio.stream}${audio.optional ? '?' : ''}`);
  const embedded = plan.subtitles.filter(subtitle => !subtitle.external);
  for (const subtitle of embedded) args.push('-map', `${subtitle.input}:s:0`);
  args.push('-c', 'copy');
  if (embedded.length) args.push('-c:s', mp4 ? 'mov_text' : 'srt');
  args.push('-disposition:v:0', 'default');
  plan.audio.forEach((audio, index) => {
    args.push(`-metadata:s:a:${index}`, `language=${audio.language || 'und'}`);
    if (audio.label) args.push(`-metadata:s:a:${index}`, `title=${audio.label}`);
    args.push(`-disposition:a:${index}`, audio.disposition || '0');
  });
  embedded.forEach((subtitle, index) => {
    args.push(`-metadata:s:s:${index}`, `language=${subtitle.language || 'und'}`);
    if (subtitle.label) args.push(`-metadata:s:s:${index}`, `title=${subtitle.label}`);
    args.push(`-disposition:s:${index}`, subtitle.disposition || '0');
  });
  const tags = { title: meta.title, show: meta.show, season_number: meta.season, episode_sort: meta.episode, date: meta.date };
  for (const [key, value] of Object.entries(tags)) if (value !== undefined && value !== null && value !== '') args.push('-metadata', `${key}=${value}`);
  if (mp4) {
    args.push('-movflags', '+faststart');
    if (plan.video.codec === 'h265') args.push('-tag:v', 'hvc1');
  }
  args.push('-f', FORMAT_OF[plan.container] || 'mp4', '-progress', 'pipe:1', '-nostats', outFile);
  return args;
}

/** WebVTT (Datei oder HLS-Untertitel-Playlist) -> .srt. */
function buildSrtArgs({ url, outFile, userAgent = null, protocolWhitelist = DEFAULT_PROTOCOLS }) {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...inputOptions(url, { userAgent, protocolWhitelist, readRate: null }), '-i', url, '-map', '0:s:0', '-c:s', 'srt', '-f', 'srt', outFile];
}

/**
 * Faktor für -readrate aus dem Bandbreitenlimit (kB/s) und der Datenrate des Stroms (bit/s). null = unbegrenzt. Werte über 20
 * (Limit weit über der Datenrate) bringen nichts und entfallen; unter 0,05 wird auf 0,05 gehoben (sonst steht der Download).
 */
function readRateFor(limitKBps, bitrate) {
  if (!limitKBps || limitKBps <= 0 || !bitrate || bitrate <= 0) return null;
  const rate = (limitKBps * 1000 * 8) / bitrate;
  if (rate >= 20) return null;
  return Math.max(0.05, Math.round(rate * 100) / 100);
}

/** Verarbeitet -progress-Zeilen (key=value); gibt je Block { timeSec, totalSize } an onBlock. */
function createProgressParser(onBlock) {
  let buffer = '';
  let fields = {};
  return chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq);
      fields[key] = line.slice(eq + 1);
      if (key === 'progress') {
        const timeSec = parseOutTimeSeconds(fields);
        const totalSize = Number(fields.total_size);
        onBlock({ timeSec, totalSize: Number.isFinite(totalSize) && totalSize > 0 ? totalSize : null, done: fields.progress === 'end' });
        fields = {};
      }
    }
  };
}

module.exports = { DEFAULT_PROTOCOLS, buildMuxArgs, buildSrtArgs, readRateFor, createProgressParser, isHttp };
