'use strict';
// HLS-Master -> MP4/MKV per ffmpeg -c copy mit mehreren Eingaengen (Video-Variante + n Audio + m Untertitel).
// Aufruf: node dl-hls.js <masterUrl> <out> [--h 720] [--audio regex] [--sub regex] [--t 30] [--codec h264|h265]
// Container ergibt sich aus der Endung von <out> (.mp4 | .mkv). Gibt ffmpeg-Kommando + ffprobe-Ergebnis aus.
const { spawnSync } = require('child_process');
const path = require('path');
const { getText, parseMaster, UA } = require('./lib');
const FFMPEG = path.join(__dirname, '../../bin/ffmpeg');
const FFPROBE = path.join(__dirname, '../../bin/ffprobe');
const LANG3 = { de: 'deu', fr: 'fra', it: 'ita', en: 'eng', nl: 'nld', es: 'spa', pl: 'pol', ov: 'und' };
(async () => {
  const a = process.argv.slice(2);
  const [master, out] = a;
  const opt = (k, d) => { const i = a.indexOf('--' + k); return i > 0 ? a[i + 1] : d; };
  const h = Number(opt('h', 720)); const audRe = new RegExp(opt('audio', '.'), 'i'); const subRe = opt('sub') && new RegExp(opt('sub'), 'i');
  const t = opt('t'); const codec = opt('codec', 'h264');
  const mp4 = /\.mp4$/i.test(out);
  const m = await getText(master); const p = parseMaster(m.text, m.url);
  let vs = p.variants.filter((v) => Number(String(v.RESOLUTION).split('x')[1]) === h);
  if (vs.length > 1) vs = vs.filter((v) => (codec === 'h265' ? /hev1|hvc1/ : /avc1/).test(v.CODECS));
  const v = vs.sort((x, y) => y.BANDWIDTH - x.BANDWIDTH)[0];
  if (!v) throw new Error('keine Variante mit Hoehe ' + h);
  const auds = p.media.filter((x) => x.TYPE === 'AUDIO' && x.URI && audRe.test(x.NAME + ' ' + (x.CHARACTERISTICS || '')));
  const subs = subRe ? p.media.filter((x) => x.TYPE === 'SUBTITLES' && x.URI && subRe.test(x.NAME + ' ' + (x.CHARACTERISTICS || ''))) : [];
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-user_agent', UA];
  const inp = (u, extra = []) => args.push(...extra, '-i', u);
  const tin = t ? ['-t', t] : [];
  inp(v.URI, tin);
  auds.forEach((x) => inp(x.URI, tin));
  subs.forEach((x) => inp(x.URI, tin));
  // Variante ohne separate Audio-Gruppe (ZDF/ARD-aeltere Manifeste): Audio aus der Variante selbst
  const useVariantAudio = auds.length === 0;
  args.push('-map', '0:v:0', ...tin);
  if (useVariantAudio) args.push('-map', '0:a:0?');
  auds.forEach((_, i) => args.push('-map', `${1 + i}:a:0`));
  subs.forEach((_, i) => args.push('-map', `${1 + auds.length + i}:s:0`));
  args.push('-disposition:v:0', 'default', '-c:v', 'copy', '-c:a', 'copy', '-c:s', mp4 ? 'mov_text' : 'srt');
  auds.forEach((x, i) => {
    args.push(`-metadata:s:a:${i}`, `language=${LANG3[x.LANGUAGE] || x.LANGUAGE || 'und'}`, `-metadata:s:a:${i}`, `title=${x.NAME}`);
    const ad = /describes-video|Audiodeskription/i.test(x.NAME + (x.CHARACTERISTICS || ''));
    args.push(`-disposition:a:${i}`, i === 0 && !ad ? 'default' : (ad ? 'visual_impaired' : '0'));
  });
  subs.forEach((x, i) => {
    args.push(`-metadata:s:s:${i}`, `language=${LANG3[x.LANGUAGE] || x.LANGUAGE || 'und'}`, `-metadata:s:s:${i}`, `title=${x.NAME}`);
    args.push(`-disposition:s:${i}`, x.FORCED === 'YES' ? 'forced' : (/transcribes-spoken-dialog/i.test(x.CHARACTERISTICS || '') && /Gehörlose|Hörgeschädigte/i.test(x.NAME) ? 'hearing_impaired' : '0'));
  });
  if (mp4) args.push('-movflags', '+faststart', '-tag:v', /hev1|hvc1/.test(v.CODECS) ? 'hvc1' : 'avc1');
  args.push(out);
  console.log('Variante:', v.RESOLUTION, v.BANDWIDTH, v.CODECS, '| Audio:', auds.map((x) => x.NAME).join(' + ') || '(muxed)', '| Subs:', subs.map((x) => x.NAME).join(' + ') || '-');
  const t0 = Date.now();
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  console.log('ffmpeg exit', r.status, ((Date.now() - t0) / 1000).toFixed(1) + 's', (r.stderr || '').trim().split('\n').slice(-4).join('\n'));
  if (r.status === 0) {
    const pr = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,width,height:stream_tags=language,title:stream_disposition=default,forced,hearing_impaired,visual_impaired:format=duration,size', '-of', 'compact', out], { encoding: 'utf8' });
    console.log(pr.stdout.trim());
  }
})().catch((e) => { console.error(e); process.exit(1); });
