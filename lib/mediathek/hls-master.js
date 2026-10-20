'use strict';

// Reiner Parser für HLS-Master-Playlists (RFC 8216): Videovarianten (EXT-X-STREAM-INF) und alternative Spuren
// (EXT-X-MEDIA: AUDIO, SUBTITLES). Kein Netz. Relative URIs werden gegen baseUrl aufgelöst. Der Master wird selbst
// geparst (statt ffmpeg die ganze Playlist zu geben), damit der Download gezielt je eine Video-, Audio- und
// Untertitelspur als getrennte Eingänge übernehmen kann (Spike-Bericht §4).

/** Attributliste ("KEY=VALUE,KEY="quoted, text"") als Objekt; Schlüssel in Großbuchstaben. */
function parseAttributes(text) {
  const attributes = {};
  const pattern = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let match;
  while ((match = pattern.exec(text))) attributes[match[1]] = match[3] !== undefined ? match[3] : match[2];
  return attributes;
}

function resolveUri(uri, baseUrl) {
  if (!uri) return null;
  try {
    return new URL(uri, baseUrl || undefined).href;
  } catch {
    return null;
  }
}

function parseResolution(value) {
  const match = /^(\d+)x(\d+)$/.exec(String(value || ''));
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

/** Videocodec aus dem CODECS-Attribut: 'h264' (avc1), 'h265' (hev1/hvc1), 'av1', sonst null. */
function videoCodecOf(codecs) {
  const text = String(codecs || '');
  if (/\b(hev1|hvc1)\b/.test(text)) return 'h265';
  if (/\bavc[13]\b/.test(text)) return 'h264';
  if (/\bav01\b/.test(text)) return 'av1';
  return null;
}

/**
 * Parst einen Master. Ergebnis:
 * { isMaster, encrypted, variants: [{ uri, bandwidth, averageBandwidth, width, height, codecs, codec, frameRate, audio, subtitles }],
 *   media: [{ type, groupId, name, language, uri, isDefault, autoselect, forced, characteristics, channels }] }
 * isMaster false: Text ist keine Master-Playlist (keine EXT-X-STREAM-INF); encrypted true bei EXT-X-(SESSION-)KEY mit METHOD != NONE.
 */
function parseHlsMaster(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim());
  const variants = [];
  const media = [];
  let encrypted = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      media.push({
        type: a.TYPE || '',
        groupId: a['GROUP-ID'] || '',
        name: a.NAME || '',
        language: a.LANGUAGE || null,
        uri: resolveUri(a.URI, baseUrl),
        isDefault: a.DEFAULT === 'YES',
        autoselect: a.AUTOSELECT === 'YES',
        forced: a.FORCED === 'YES',
        characteristics: a.CHARACTERISTICS || '',
        channels: a.CHANNELS || null,
      });
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      let next = index + 1;
      while (next < lines.length && (!lines[next] || lines[next].startsWith('#'))) next += 1; // Kommentarzeilen zwischen Tag und URI
      const uri = resolveUri(lines[next], baseUrl);
      if (!uri) continue;
      index = next;
      const resolution = parseResolution(a.RESOLUTION);
      variants.push({
        uri,
        bandwidth: Number(a.BANDWIDTH) || 0,
        averageBandwidth: Number(a['AVERAGE-BANDWIDTH']) || null,
        width: resolution ? resolution.width : null,
        height: resolution ? resolution.height : null,
        codecs: a.CODECS || '',
        codec: videoCodecOf(a.CODECS),
        frameRate: Number(a['FRAME-RATE']) || null,
        audio: a.AUDIO || null,
        subtitles: a.SUBTITLES || null,
      });
    } else if (/^#EXT-X-(SESSION-)?KEY:/.test(line)) {
      const a = parseAttributes(line.slice(line.indexOf(':') + 1));
      if (a.METHOD && a.METHOD !== 'NONE') encrypted = true;
    }
  }
  return { isMaster: variants.length > 0, encrypted, variants, media };
}

/** Varianten absteigend nach Höhe, dann H.264 vor H.265 vor anderen, dann nach Bandbreite (arte sortiert nicht nach Auflösung). */
function sortVariants(variants) {
  const rank = codec => (codec === 'h264' ? 0 : codec === 'h265' ? 1 : 2);
  return [...variants].sort((a, b) => (b.height || 0) - (a.height || 0) || rank(a.codec) - rank(b.codec) || (b.averageBandwidth || b.bandwidth) - (a.averageBandwidth || a.bandwidth));
}

module.exports = { parseHlsMaster, parseAttributes, sortVariants, videoCodecOf };
