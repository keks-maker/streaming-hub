/**
 * Kanonischer EPG-Schlüssel eines Senders — die einzige Normalisierung für Zuordnung
 * Senderliste (tvg-id / Name) ↔ EPG-Kanal-ID, in Main (EpgStore) und Renderer.
 *
 * Schritte: XML-Entities dekodieren → klein, ohne Akzente → "@Suffix" (Qualität/Region) entfernen →
 * Länderendung (".de", genau zwei Buchstaben am Ende) abtrennen → im Rest alles außer Buchstaben und
 * Ziffern entfernen ("+" zählt als "plus") → Alias-Tabelle → Endung wieder anhängen.
 * "Das.Erste.de", "DasErste.de@HD" und "Das Erste.de" ergeben alle "daserste.de".
 * Idempotent: normalizeEpgKey(normalizeEpgKey(x)) === normalizeEpgKey(x).
 */

/**
 * Sonderfälle, in denen die Quellen unterschiedliche Namen für denselben Sender nutzen
 * (Schlüssel und Ziel sind bereits normalisiert; Ziele sind selbst keine Schlüssel).
 */
export const EPG_KEY_ALIASES: Readonly<Record<string, string>> = {
  'brfernsehen.de': 'br.de',
  'hrfernsehen.de': 'hr.de',
  'mdrfernsehen.de': 'mdr.de',
  'ndrfernsehen.de': 'ndr.de',
  'wdrfernsehen.de': 'wdr.de',
  'rbbfernsehen.de': 'rbb.de',
  'swrfernsehen.de': 'swrsr.de',
  'swrfernsehenhd.de': 'swrsr.de',
  'swrfernsehenbadenwurttemberg.de': 'swrsr.de',
  'swrfernsehenrheinlandpfalz.de': 'swrsr.de',
  'rtlsuper.de': 'superrtl.de',
  'srf.de': 'srf1.de',
};

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    const lower = body.toLowerCase();
    if (lower in NAMED_ENTITIES) return NAMED_ENTITIES[lower]!;
    if (lower[0] === '#') {
      const code = lower[1] === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
    }
    return match;
  });
}

export function normalizeEpgKey(id: string): string {
  let s = decodeXmlEntities(typeof id === 'string' ? id : '');
  s = s.replace(/@[^.@]*/g, '').toLowerCase().trim();
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const m = s.match(/^(.*)\.([a-z]{2})$/);
  let base = s;
  let tld = '';
  if (m && m[1]) {
    base = m[1];
    tld = '.' + m[2];
  }
  base = base.replace(/\+/g, 'plus').replace(/[^\p{L}\p{N}]+/gu, '');
  if (!base) return '';
  const key = base + tld;
  return Object.prototype.hasOwnProperty.call(EPG_KEY_ALIASES, key) ? EPG_KEY_ALIASES[key]! : key;
}
