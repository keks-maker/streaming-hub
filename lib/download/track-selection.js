'use strict';

// Spurwahl eines Downloads (rein, kein Netz): Eingabe = resolveForDownload-Ergebnis (lib/mediathek/download-info.js) und wirksame
// Optionen (Einstellungen + Überschreibungen aus dem Dialog), Ausgabe = Plan { mode, container, video, inputs, audio, subtitles,
// estimatedBytes, warnings }. Zwei Mechanismen (Konzept §7, Spike-Bericht §2):
//  - "files" (ARD/ZDF): Tonvarianten sind getrennte Dateien; die gewählte Videostufe trägt die Standardspur, weitere Tonspuren
//    kommen aus ihren eigenen Dateien (nur der Ton wird übernommen).
//  - "media" (arte): HLS-Varianten mit EXT-X-MEDIA-Gruppen; Video, jede Tonspur und jeder Untertitel sind getrennte Eingänge.
// Kein Transcoding: alles wird kopiert; Untertitel nur als WebVTT (mov_text im MP4, srt im MKV).
//
// Plan-Felder:
//  mode: 'http' (eine progressive MP4-Datei, Range-Resume) | 'ffmpeg' (Muxen aus inputs)
//  video: { kind, url, needsMaster, height, codec, bitrate, label }   needsMaster: url ist ein HLS-Master, die Variante wählt der Job
//  inputs: [{ url, needsMaster? }]   ffmpeg-Eingänge; inputs[0] ist die Videoquelle (leer im Modus http)
//  audio: [{ id, kind, language, label, input, stream, optional?, disposition }]   input = Index in inputs
//  subtitles: [{ id, kind, language, label, url, input|null, external, disposition }]

const { sortVariants } = require('../mediathek/hls-master.js');

const LANG3 = { de: 'deu', deu: 'deu', ger: 'deu', fr: 'fra', fra: 'fra', fre: 'fra', it: 'ita', ita: 'ita', en: 'eng', eng: 'eng', es: 'spa', spa: 'spa', nl: 'nld', nld: 'nld', dut: 'nld', pl: 'pol', pol: 'pol', tr: 'tur', tur: 'tur', ov: 'orig' };
const EXTRA_AUDIO_BPS = 128000;
/** Grobe Datenrate je Bildhöhe (bit/s), wenn die Quelle keine nennt; Spike-Messwerte (720p ca. 2,6 Mbit/s, 1080p ca. 5 Mbit/s). */
const HEIGHT_BPS = { 2160: 15000000, 1080: 5000000, 720: 2600000, 576: 1800000, 540: 1500000, 480: 1200000, 432: 1200000, 360: 900000, 270: 600000 };

function iso3(language) {
  const key = String(language || '').toLowerCase().split(/[-_]/)[0];
  return LANG3[key] || (/^[a-z]{3}$/.test(key) ? key : 'und');
}

function maxHeightOf(options) {
  return options.maxHeight === 'best' ? Infinity : Number(options.maxHeight) || Infinity;
}

function approxBitrate(variant) {
  if (variant.bitrate) return variant.bitrate;
  const heights = Object.keys(HEIGHT_BPS).map(Number).sort((a, b) => a - b);
  const height = variant.height || 720;
  const match = heights.find(candidate => candidate >= height) || heights[heights.length - 1];
  return HEIGHT_BPS[match];
}

const codecRank = codec => (codec === 'h264' ? 0 : codec === 'h265' ? 1 : 2);

/** Videostufe: höchste Auflösung innerhalb des Limits (sonst die niedrigste vorhandene); gleiche Höhe: progressiv, H.264, hohe Rate. */
function pickVariant(variants, maxHeight) {
  const usable = variants.filter(variant => variant && typeof variant.url === 'string' && variant.url);
  if (!usable.length) return null;
  const order = (a, b) =>
    (b.height || 0) - (a.height || 0) ||
    (a.kind === 'progressive' ? 0 : 1) - (b.kind === 'progressive' ? 0 : 1) ||
    codecRank(a.codec) - codecRank(b.codec) ||
    (b.bitrate || 0) - (a.bitrate || 0);
  const known = usable.filter(variant => variant.height);
  const within = usable.filter(variant => !variant.height || variant.height <= maxHeight);
  // nur Stufen ohne Höhenangabe (HLS "Auto") und eine bekannte Obergrenze: bekannte Stufen haben Vorrang vor "Auto"
  const pool = within.some(variant => variant.height) ? within.filter(variant => variant.height) : within;
  if (pool.length) return [...pool].sort(order)[0];
  return [...known].sort((a, b) => (a.height || 0) - (b.height || 0))[0] || usable[0];
}

/** Variante eines geparsten HLS-Masters (hls-master.js) innerhalb des Limits: höchste Höhe, H.264 vor H.265, hohe Rate. */
function pickHlsVariant(parsedMaster, maxHeight) {
  const variants = sortVariants(parsedMaster.variants || []);
  const within = variants.filter(variant => !variant.height || variant.height <= maxHeight);
  if (within.length) return within[0];
  return [...variants].sort((a, b) => (a.height || 0) - (b.height || 0))[0] || null;
}

/** ISO-639-2-Code für die Metadaten der Tonspur ('und' bei unbekanntem Originalton). */
function metaLanguage(track) {
  const code = iso3(track.language);
  return code === 'orig' ? 'und' : code;
}

const languageOf = track => (track.kind === 'original' ? 'orig' : iso3(track.language));

/** Wahl der Tonspuren aus den Tracks der Quelle. */
function selectAudioTracks(tracks, options, warnings) {
  const usable = tracks.filter(track => track && track.kind !== 'sign-language'); // Gebärdensprache nie
  const mains = usable.filter(track => track.kind === 'main' || track.kind === 'original');
  const ads = usable.filter(track => track.kind === 'audio-description');
  const clear = usable.filter(track => track.kind === 'clear-speech');
  const order = options.audioLanguages && options.audioLanguages.length ? options.audioLanguages : ['deu'];
  const rank = track => {
    const index = order.indexOf(languageOf(track));
    return index < 0 ? order.length : index;
  };
  const byPreference = (a, b) => rank(a) - rank(b) || Number(b.isDefault) - Number(a.isDefault);
  let chosen = [];
  if (options.audioMode === 'all') {
    chosen = [...mains].sort(byPreference);
    chosen.push(...[...clear].sort(byPreference));
  } else {
    const wanted = order.map(language => mains.filter(track => languageOf(track) === language).sort(byPreference)[0]).find(Boolean);
    const fallback = wanted || mains.find(track => track.isDefault) || mains[0];
    if (fallback) chosen.push(fallback);
    if (!wanted && fallback) warnings.push('Bevorzugte Sprache nicht vorhanden, Standardton gewählt.');
  }
  const lead = chosen[0] ? languageOf(chosen[0]) : order[0];
  const adFor = language => ads.find(track => languageOf(track) === language) || ads[0];
  if (options.audioDescription === 'additional' && ads.length) {
    if (options.audioMode === 'all') chosen.push(...ads);
    else chosen.push(adFor(lead));
  } else if (options.audioDescription === 'fallback' && !chosen.length && ads.length) {
    chosen.push(adFor(lead));
  }
  if (!chosen.length && usable.length) {
    chosen.push(usable[0]);
    warnings.push('Keine normale Tonspur vorhanden, vorhandene Spur gewählt.');
  }
  return chosen;
}

/** Untertitel: nur WebVTT; bevorzugte Sprache (eine Spur: normale vor Hörgeschädigte) oder alle (inkl. erzwungene). */
function selectSubtitles(subtitles, options) {
  if (options.subtitleMode === 'none') return [];
  const usable = subtitles.filter(subtitle => subtitle && subtitle.format === 'webvtt' && subtitle.url);
  if (options.subtitleMode === 'all') return usable;
  const language = options.subtitleLanguage || 'deu';
  const inLanguage = usable.filter(subtitle => iso3(subtitle.language) === language && subtitle.kind !== 'forced');
  const pick = inLanguage.find(subtitle => subtitle.kind === 'normal') || inLanguage[0];
  return pick ? [pick] : [];
}

function audioDisposition(track, isLead) {
  if (track.kind === 'audio-description') return 'visual_impaired';
  return isLead ? 'default' : '0';
}

function subtitleDisposition(subtitle) {
  if (subtitle.kind === 'hearing-impaired') return 'hearing_impaired';
  if (subtitle.kind === 'forced') return 'forced';
  return '0';
}

function estimateBytes(info, video, extraInputs) {
  if (!info.durationSeconds || !video) return null;
  const bps = approxBitrate(video) + extraInputs * EXTRA_AUDIO_BPS;
  return Math.round((bps / 8) * info.durationSeconds);
}

/**
 * Plan für einen Download. info = resolveForDownload-Ergebnis (ohne restriction), options = wirksame Optionen.
 * Rückgabe { ok: true, plan } oder { ok: false, code: 'no-video', message }.
 */
function buildPlan(info, options) {
  const warnings = [];
  const container = options.container === 'mkv' ? 'mkv' : 'mp4';
  const tracks = Array.isArray(info.audioTracks) ? info.audioTracks : [];
  const mediaMechanism = tracks.some(track => track.uri) || (info.variants || []).some(variant => 'audioGroup' in variant);
  const maxHeight = maxHeightOf(options);
  let variants = info.variants || [];
  let audioSource = tracks;
  if (mediaMechanism) {
    const lead = pickVariant(variants, maxHeight);
    // Tonspuren der Gruppe der gewählten Variante (fehlt die Zuordnung, gelten alle)
    if (lead && lead.audioGroup) {
      const inGroup = tracks.filter(track => track.groupId === lead.audioGroup);
      if (inGroup.length) audioSource = inGroup;
    }
    variants = lead ? [lead] : [];
  }
  const chosenTracks = selectAudioTracks(audioSource, options, warnings);
  const primary = mediaMechanism ? null : audioSource.find(track => track.kind === 'main' && (track.url || track.hlsUrl)) || null;

  let video = pickVariant(variants, maxHeight);
  let videoFromTrack = null;
  if (!video) {
    // keine Standardvariante (z. B. nur Audiodeskription vorhanden): die Datei der gewählten Spur trägt das Bild
    videoFromTrack = chosenTracks.find(track => track.url || track.hlsUrl) || null;
    if (!videoFromTrack) return { ok: false, code: 'no-video', message: 'Für diesen Beitrag wurde kein ladbarer Stream gefunden.' };
    const useMp4 = Boolean(videoFromTrack.url);
    video = { id: `track-${videoFromTrack.id}`, kind: useMp4 ? 'progressive' : 'hls', url: useMp4 ? videoFromTrack.url : videoFromTrack.hlsUrl, width: null, height: null, bitrate: null, codec: 'h264', label: null };
    warnings.push('Auflösung kann nicht begrenzt werden.');
  } else if (Number.isFinite(maxHeight) && video.height && video.height > maxHeight) {
    warnings.push(`Mindestens ${video.height}p verfügbar, gewünschte Obergrenze ${maxHeight}p nicht möglich.`);
  }
  const needsMaster = video.kind === 'hls' && !('audioGroup' in video);
  const inputs = [{ url: video.url, ...(needsMaster ? { needsMaster: true } : {}) }];
  const leadTrack = primary || videoFromTrack;
  const audio = [];
  const extraAudioInputs = [];
  for (const track of chosenTracks) {
    let entry;
    if (mediaMechanism) {
      inputs.push({ url: track.uri });
      entry = { input: inputs.length - 1, stream: 'a:0' };
    } else if (leadTrack && track.id === leadTrack.id) {
      entry = { input: 0, stream: 'a:0' };
    } else if (track.url) {
      inputs.push({ url: track.url });
      extraAudioInputs.push(track);
      entry = { input: inputs.length - 1, stream: 'a:0' };
    } else if (track.hlsUrl) {
      inputs.push({ url: track.hlsUrl, needsMaster: true });
      extraAudioInputs.push(track);
      entry = { input: inputs.length - 1, stream: 'a:0' };
    } else {
      warnings.push(`Tonspur "${track.label}" nicht ladbar, ausgelassen.`);
      continue;
    }
    audio.push({ id: track.id, kind: track.kind, language: metaLanguage(track), label: track.label, ...entry, disposition: 'default' });
  }
  if (!audio.length) {
    // Variante mit eingebettetem Ton (arte-Master ohne EXT-X-MEDIA): Ton aus dem Videoeingang, falls vorhanden
    audio.push({ id: 'embedded', kind: 'main', language: 'deu', label: 'Ton', input: 0, stream: 'a:0', optional: true, disposition: 'default' });
  }
  // Disposition: erste normale Spur = default, Audiodeskription = visual_impaired, Rest keine
  let leadSet = false;
  for (const entry of audio) {
    const isLead = !leadSet && entry.kind !== 'audio-description';
    if (isLead) leadSet = true;
    entry.disposition = audioDisposition(entry, isLead);
  }

  const subtitles = [];
  const external = options.subtitleDelivery === 'external';
  for (const subtitle of selectSubtitles(info.subtitles || [], options)) {
    let input = null;
    if (!external) {
      inputs.push({ url: subtitle.url });
      input = inputs.length - 1;
    }
    subtitles.push({ id: subtitle.id, kind: subtitle.kind, language: iso3(subtitle.language), label: subtitle.label, url: subtitle.url, input, external, disposition: subtitleDisposition(subtitle) });
  }

  const embeddedSubtitles = subtitles.some(subtitle => !subtitle.external);
  const httpMode = video.kind === 'progressive' && inputs.length === 1 && container === 'mp4' && !embeddedSubtitles && audio.length === 1 && audio[0].input === 0;
  const plan = {
    mode: httpMode ? 'http' : 'ffmpeg',
    container,
    video: { kind: video.kind, url: video.url, needsMaster, height: video.height || null, codec: video.codec || 'h264', bitrate: video.bitrate || null, label: video.label || null },
    inputs: httpMode ? [] : inputs,
    audio,
    subtitles,
    estimatedBytes: estimateBytes(info, video, extraAudioInputs.length + (mediaMechanism ? Math.max(0, audio.length - 1) : 0)),
    warnings,
  };
  return { ok: true, plan };
}

module.exports = { iso3, pickVariant, pickHlsVariant, selectAudioTracks, selectSubtitles, buildPlan, approxBitrate, maxHeightOf, HEIGHT_BPS };
