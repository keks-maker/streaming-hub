// Suchtext-Faltung für das EPG (Etappe 3.1; EPG-Konzept §4 A-1/A-2)
//
// Reines Modul ohne Node-/Electron-/DOM-Abhängigkeit: Main-Suche (EpgStore) und
// Renderer (lib/epg-grid.js, später Bundle) falten mit EXAKT derselben Funktion.
//
// Faltungsregel foldText (auf Suchtext UND Query angewandt, danach Teilstring-Vergleich):
//   1. Kleinschreibung (toLowerCase)
//   2. Sonderbuchstaben ohne Unicode-Zerlegung: æ→ae, œ→oe, ø→o, ł→l, đ→d, ı→i
//   3. NFD-Zerlegung, alle kombinierenden Zeichen (U+0300–U+036F) entfernen: ä→a, é→e, ñ→n
//   4. ß→ss
//   5. Umlaut-Digraphen zusammenziehen: ae→a, oe→o, ue→u
//   6. Whitespace-Folgen → ein Leerzeichen, Ränder entfernt
// Ergebnis: "Käse", "kase" und "Kaese" falten alle zu "kase" und finden sich
// gegenseitig. Preis: leichtes Übertreffen (z. B. findet "michael" auch "Michal",
// "queen" auch "Qeen") — nie zu wenige Treffer.

'use strict';

const SPECIAL = { æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ı: 'i' };
const SPECIAL_RE = /[æœøłđı]/g;
const COMBINING_RE = /[̀-ͯ]/g;

function foldText(value) {
  if (typeof value !== 'string' || !value) return '';
  return value
    .toLowerCase()
    .replace(SPECIAL_RE, ch => SPECIAL[ch])
    .normalize('NFD')
    .replace(COMBINING_RE, '')
    .replace(/ß/g, 'ss')
    .replace(/([aou])e/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { foldText };
