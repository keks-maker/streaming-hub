'use strict';

// Test-Helfer (Etappe 3.1, L-6): deterministische Großfixture für das EPG —
// N Kanäle × M Tage mit realistischen Sendungslängen (15–180 min, lückenlos je Kanal).
// Für Performance-/Virtualisierungstests. Dateien in tests/helpers sind KEINE Tests.
//
//   generateChannelSlots({ channels, days, startMs, seed })
//       → Map<rohe Kanal-ID, Slot[]>   (direkt für EpgStore.setSource)
//   buildXmltv({ channels, days, startMs, seed })
//       → XMLTV-String (für EpgService/Parser; fetchImpl: async () => new Response(xml))
//   channelId(i) → 'sender001.de' (Kanal-ID i, 0-basiert)

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

const DURATIONS_MIN = [15, 25, 30, 30, 45, 45, 60, 60, 90, 120, 180];
const WORDS = [
  'Tagesschau',
  'Käse',
  'Krimi',
  'Wetter',
  'Nachrichten',
  'Sport',
  'Dokumentation',
  'Spielfilm',
  'Quiz',
  'Heimat',
  'Märchen',
  'Straße',
  'Reportage',
  'Magazin',
  'Serie',
  'Musik',
  'Natur',
  'Reise',
  'Kochen',
  'Komödie',
];

function channelId(i) {
  return `sender${String(i + 1).padStart(3, '0')}.de`;
}

/** Kleiner deterministischer Zufallsgenerator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function* programmes({ channels = 438, days = 10, startMs, seed = 1 }) {
  if (!Number.isFinite(startMs)) throw new Error('startMs ist erforderlich');
  for (let c = 0; c < channels; c += 1) {
    const rand = rng(seed * 7919 + c);
    let t = startMs;
    let n = 0;
    while (t < startMs + days * DAY) {
      const dur = DURATIONS_MIN[Math.floor(rand() * DURATIONS_MIN.length)] * MIN;
      const word = WORDS[Math.floor(rand() * WORDS.length)];
      yield {
        channel: channelId(c),
        start: t,
        stop: t + dur,
        title: `${word} ${c + 1}-${n}`,
        desc: `Beschreibung zu ${word} (Kanal ${c + 1}, Folge ${n}).`,
      };
      t += dur;
      n += 1;
    }
  }
}

function generateChannelSlots(options) {
  const map = new Map();
  for (const p of programmes(options)) {
    let list = map.get(p.channel);
    if (!list) {
      list = [];
      map.set(p.channel, list);
    }
    list.push({ start: p.start, stop: p.stop, title: p.title, desc: p.desc });
  }
  return map;
}

function xmltvTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildXmltv(options) {
  const channels = options.channels ?? 438;
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="streaming-hub-test">\n'];
  for (let c = 0; c < channels; c += 1) {
    parts.push(`<channel id="${channelId(c)}"><display-name>Sender ${c + 1}</display-name></channel>\n`);
  }
  for (const p of programmes(options)) {
    parts.push(
      `<programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.stop)}" channel="${p.channel}">` +
        `<title lang="de">${escapeXml(p.title)}</title><desc lang="de">${escapeXml(p.desc)}</desc></programme>\n`,
    );
  }
  parts.push('</tv>\n');
  return parts.join('');
}

module.exports = { generateChannelSlots, buildXmltv, channelId, programmes, MIN, DAY };
