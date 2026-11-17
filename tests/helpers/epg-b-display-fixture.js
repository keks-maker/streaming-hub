'use strict';

// Test-Helfer (Etappe 3.6): XMLTV-Fixtures für die Anzeige der B-Felder (Genre-Chips, Detail-Modal, Vorschaubilder).
// Zeiten sind relativ zu baseMs (E2E: „jetzt“), damit „läuft“, „danach“ und „Läuft auch“ deterministisch sind.
// Dateien in tests/helpers sind KEINE Tests.
//
//   buildDisplayXmltv({ baseMs })  kleine Fixture: alle B-Felder, Lücken, bösartige Werte (HTML in Titel/Credits,
//                                  javascript:-/data:-Icons), Bildfehler, http-Icon (die CSP lässt nur https zu)
//   buildThumbXmltv({ baseMs, channels })  viele Sender mit je drei Sendungen und eindeutiger Bild-URL (Thumbnail-Messung)
//   IMG_HOST, DISPLAY_CHANNELS, thumbChannelId(i)

const MIN = 60 * 1000;
const IMG_HOST = 'https://img.e2e.invalid';

const DISPLAY_CHANNELS = [
  { id: 'G1.de', name: 'Genre Eins' },
  { id: 'G2.de', name: 'Genre Zwei' },
  { id: 'G3.de', name: 'Genre Drei' },
  { id: 'G4.de', name: 'Genre Vier' },
];

function xmltvTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
}

const esc = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Sendung als XMLTV. `raw` Felder werden unverändert eingesetzt (bereits escaped). */
function programme(base, channel, startMin, stopMin, p) {
  const parts = [`<title lang="de">${p.rawTitle !== undefined ? p.rawTitle : esc(p.title)}</title>`];
  if (p.sub !== undefined) parts.push(`<sub-title lang="de">${p.sub}</sub-title>`);
  if (p.desc !== undefined) parts.push(`<desc lang="de">${p.desc}</desc>`);
  if (p.credits) parts.push(`<credits>${p.credits}</credits>`);
  for (const category of p.categories || []) parts.push(`<category lang="de">${category}</category>`);
  if (p.date) parts.push(`<date>${p.date}</date>`);
  if (p.episode) parts.push(`<episode-num system="onscreen">${p.episode}</episode-num>`);
  if (p.icon) parts.push(`<icon src="${esc(p.icon)}"/>`);
  if (p.rating !== undefined) parts.push(`<rating system="FSK"><value>${p.rating}</value></rating>`);
  return `<programme start="${xmltvTime(base + startMin * MIN)}" stop="${xmltvTime(base + stopMin * MIN)}" channel="${channel}">${parts.join('')}</programme>`;
}

function buildDisplayXmltv({ baseMs }) {
  const g = (channel, a, b, p) => programme(baseMs, channel, a, b, p);
  const tatort = (channel, a, b) => g(channel, a, b, { title: 'Tatort', categories: ['Krimi'], desc: 'Ein Fall für zwei.', icon: `${IMG_HOST}/p/tatort-${channel}-${a}.png` });
  const out = ['<?xml version="1.0" encoding="UTF-8"?><tv generator-info-name="streaming-hub-test">'];
  for (const c of DISPLAY_CHANNELS) out.push(`<channel id="${c.id}"><display-name>${c.name}</display-name></channel>`);
  out.push(
    // G1: alle Felder, Genres, Lücken, bösartige Werte
    g('G1.de', -30, 30, {
      title: 'Krimi Voll',
      sub: 'Der Untertitel &amp; mehr',
      desc: 'Beschreibung zu Krimi Voll.',
      credits:
        '<director>Regie Eins</director><actor>Darsteller 1</actor><actor>Darsteller 2</actor><actor>Darsteller 3</actor><actor>Darsteller 4</actor><actor>Darsteller 5</actor><actor>Darsteller 6</actor>',
      categories: ['Krimi', 'Drama'],
      date: '20190501',
      episode: 'S2 E3',
      icon: `${IMG_HOST}/p/krimi.png`,
      rating: 'FSK 12',
    }),
    g('G1.de', 30, 90, { title: 'Sport Live', categories: ['Sport'], desc: 'Handball live.', icon: `${IMG_HOST}/p/sport.png` }),
    g('G1.de', 90, 120, { title: 'Nachrichten Spezial', categories: ['Nachrichten'], desc: 'Aktuelles.' }),
    tatort('G1.de', 120, 180),
    g('G1.de', 180, 210, { title: 'Ohne Felder' }),
    g('G1.de', 210, 240, {
      rawTitle: '&lt;img src=x onerror=window.__pwned=1&gt; &amp; Co',
      sub: '&lt;b&gt;fett&lt;/b&gt;',
      desc: '&lt;script&gt;window.__pwned=1&lt;/script&gt; Beschreibung',
      credits: '<director>&lt;i&gt;Regie&lt;/i&gt;</director><actor>&lt;script&gt;window.__pwned=1&lt;/script&gt;</actor><actor>A &amp; B</actor>',
      categories: ['Unterhaltung'],
      date: '2020',
      episode: '&lt;S1&gt; E2',
      icon: 'javascript:window.__pwned=1',
      rating: '&lt;i&gt;FSK&lt;/i&gt;',
    }),
    g('G1.de', 240, 270, { title: 'Icon data', icon: 'data:image/png;base64,AAAA', categories: ['Dokumentation'] }),
    g('G1.de', 270, 300, { title: 'Icon http', icon: 'http://img.e2e.invalid/http.png', categories: ['Dokumentation'] }),
    g('G1.de', 300, 330, { title: 'Kaputtes Bild', icon: `${IMG_HOST}/broken.png`, categories: ['Serie'] }),
    g('G1.de', 330, 360, { title: 'Kinder Zeit', categories: ['Kinder'] }),
    // G2: läuft + „Läuft auch“-Wiederholung
    tatort('G2.de', -10, 50),
    g('G2.de', 50, 110, { title: 'Doku Welt', categories: ['Dokumentation'] }),
    g('G2.de', 110, 170, { title: 'Serien Marathon', categories: ['Serie'] }),
    tatort('G2.de', 400, 460),
    // G3: ohne Kategorie, Musik
    g('G3.de', 20, 80, { title: 'Musik Gala', categories: ['Musik'] }),
    g('G3.de', 80, 130, { title: 'Genre unbekannt' }),
    tatort('G3.de', 300, 360),
    tatort('G3.de', 500, 560),
    // G4: weitere Wiederholungen (insgesamt 7 weitere Tatort-Termine neben dem von G1 → 5 + „+ 2 weitere“)
    tatort('G4.de', 360, 420),
    tatort('G4.de', 600, 660),
    tatort('G4.de', 700, 760),
  );
  out.push('</tv>');
  return out.join('\n');
}

function thumbChannelId(i) {
  return `T${String(i + 1).padStart(3, '0')}.de`;
}

/** channels Sender, je: läuft (−20…+40), danach (+40…+100), übernächste (+100…+160) — jede Sendung mit eigener Bild-URL. */
function buildThumbXmltv({ baseMs, channels = 120 }) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?><tv generator-info-name="streaming-hub-test">'];
  const cats = ['Sport', 'Krimi', 'Nachrichten', 'Dokumentation'];
  for (let c = 0; c < channels; c += 1) out.push(`<channel id="${thumbChannelId(c)}"><display-name>Thumb ${c + 1}</display-name></channel>`);
  for (let c = 0; c < channels; c += 1) {
    [
      [-20, 40],
      [40, 100],
      [100, 160],
    ].forEach(([a, b], n) => {
      out.push(
        programme(baseMs, thumbChannelId(c), a, b, {
          title: `Sendung ${c + 1}-${n + 1}`,
          categories: [cats[(c + n) % cats.length]],
          icon: `${IMG_HOST}/t/${c + 1}-${n + 1}.png`,
        }),
      );
    });
  }
  out.push('</tv>');
  return out.join('\n');
}

module.exports = { IMG_HOST, DISPLAY_CHANNELS, MIN, buildDisplayXmltv, buildThumbXmltv, thumbChannelId };
